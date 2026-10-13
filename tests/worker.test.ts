import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { linkSchema, sessionSchema } from "../shared/contracts";
import worker from "../src/index";
import { createExecutionContext } from "cloudflare:test";

const ORIGIN = "http://localhost:5173";
const DESTINATION = "https://example.com/notes?source=original";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_events"), env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM administrators"),
    env.DB.prepare("UPDATE settings SET value = 3 WHERE name = 'generated_syllables'"),
  ]);
});

async function create(slug: string) {
  const response = await SELF.fetch(`${ORIGIN}/api/links`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ slug, destination: DESTINATION, title: 'Notes <script>alert("unsafe")</script>' }),
  });
  expect(response.status).toBe(201);
  return linkSchema.parse(await response.json());
}

describe("Worker request flow", () => {
  it("creates, redirects without caching, and previews an escaped destination without following it", async () => {
    await create("notes");
    const redirect = await SELF.fetch(`${ORIGIN}/notes?injected=ignored`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("Location")).toBe(DESTINATION);
    expect(redirect.headers.get("Cache-Control")).toBe("no-store");
    expect(redirect.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const preview = await SELF.fetch(`${ORIGIN}/notes+`);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("X-Robots-Tag")).toContain("noindex");
    const html = await preview.text();
    expect(html).toContain("example.com");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("unsafe")</script>');
    const alternate = await SELF.fetch("http://127.0.0.1:5173/notes");
    expect(alternate.status).toBe(200);
    expect(await alternate.text()).toContain("Continue to destination");
  });

  it("blocks public preview and redirect immediately after revoke, expiry or deletion", async () => {
    await create("notes");
    const revoke = await SELF.fetch(`${ORIGIN}/api/links/notes`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ status: "revoked" }),
    });
    expect(revoke.status).toBe(200);
    expect((await SELF.fetch(`${ORIGIN}/notes`, { redirect: "manual" })).status).toBe(410);
    expect((await SELF.fetch(`${ORIGIN}/notes+`)).status).toBe(410);
    await env.DB.prepare("UPDATE links SET status = 'active', expires_at = '2000-01-01T00:00:00.000Z' WHERE slug = 'notes'").run();
    expect((await SELF.fetch(`${ORIGIN}/notes`, { redirect: "manual" })).status).toBe(410);
    const removal = await SELF.fetch(`${ORIGIN}/api/links/notes`, { method: "DELETE", headers: { Origin: ORIGIN } });
    expect(removal.status).toBe(204);
    expect((await SELF.fetch(`${ORIGIN}/notes+`)).status).toBe(404);
    const html = await (await SELF.fetch(`${ORIGIN}/notes+`)).text();
    expect(html).not.toContain(DESTINATION);
  });

  it("rejects cross-origin writes and enforces the JSON byte limit", async () => {
    const crossOrigin = await SELF.fetch(`${ORIGIN}/api/links`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ destination: DESTINATION }),
    });
    expect(crossOrigin.status).toBe(403);
    const missingOrigin = await SELF.fetch(`${ORIGIN}/api/links/notes`, { method: "DELETE" });
    expect(missingOrigin.status).toBe(403);
    const oversized = await SELF.fetch(`${ORIGIN}/api/links`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ destination: DESTINATION, title: "x".repeat(9000) }),
    });
    expect(oversized.status).toBe(413);
  });

  it("supports HEAD and rejects encoded path separators, unknown hosts and invalid methods", async () => {
    await create("notes");
    const head = await SELF.fetch(`${ORIGIN}/notes`, { method: "HEAD", redirect: "manual" });
    expect(head.status).toBe(302);
    expect(await head.text()).toBe("");
    expect((await SELF.fetch(`${ORIGIN}/notes%2Fother`)).status).toBe(404);
    expect((await SELF.fetch("http://attacker.example/notes", { redirect: "manual" })).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/notes`, { method: "POST" })).status).toBe(405);
  });

  it("keeps management endpoints on the configured admin subdomain and requires Access there", async () => {
    const environment = {
      ...env, SHORT_ORIGIN: "https://v4ri.link", ADMIN_ORIGIN: "https://admin.v4ri.link",
      PREVIEW_ORIGIN: "https://preview.v4ri.link", ACCESS_ISSUER: "https://test.cloudflareaccess.com",
      ACCESS_AUDIENCE: "test-audience", ADMIN_EMAILS: "owner@example.com", LOCAL_DEVELOPMENT: "true",
    };
    const request = (url: string) => worker.fetch(new Request(url), environment, createExecutionContext());
    expect((await request("https://v4ri.link/api/links")).status).toBe(404);
    expect((await request("https://preview.v4ri.link/api/links")).status).toBe(404);
    expect((await request("https://admin.v4ri.link/api/links")).status).toBe(401);
    const redirect = await request("https://v4ri.link/admin/");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("Location")).toBe("https://admin.v4ri.link");
  });

  it("exports only current links and reports the active admin configuration", async () => {
    await create("notes");
    const session = sessionSchema.parse(await (await SELF.fetch(`${ORIGIN}/api/session`)).json());
    expect(session.shortOrigin).toBe(ORIGIN);
    const exported = await SELF.fetch(`${ORIGIN}/api/export`);
    expect(exported.headers.get("Content-Disposition")).toContain("ratatoskr-links.json");
    expect(await exported.json()).toHaveLength(1);
  });
});
