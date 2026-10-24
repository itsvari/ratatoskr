import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkSchema, sessionSchema } from "../shared/contracts";
import { storePreviewImage } from "../src/preview-image";
import { compressPreviewSection } from "../shared/preview-compression";
import { PREVIEW_IMAGE_WIDTH, PREVIEW_IMAGE_HEIGHT, PREVIEW_HEADER_HEIGHT } from "../shared/preview-image";
import type { Link } from "../shared/contracts";
import worker from "../src/index";
import { createExecutionContext } from "cloudflare:test";

const ORIGIN = "http://localhost:5173";
const DESTINATION = "https://example.com/notes?source=original";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM site_settings_audit"),
    env.DB.prepare("DELETE FROM preview_images"), env.DB.prepare("DELETE FROM audit_events"), env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM administrators"),
    env.DB.prepare("UPDATE settings SET value = 3 WHERE name = 'generated_syllables'"),
    env.DB.prepare("UPDATE site_settings SET display_name = 'Ratatoskr' WHERE singleton = 1"),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

async function create(slug: string) {
  const response = await SELF.fetch(`${ORIGIN}/api/links`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ slug, destination: DESTINATION, title: 'Notes <script>alert("unsafe")</script>' }),
  });
  expect(response.status).toBe(201);
  const link = linkSchema.parse(await response.json());
  await uploadImage(link);
  return link;
}

async function uploadImage(link: Link): Promise<void> {
  const pixels = new Uint8Array(PREVIEW_IMAGE_WIDTH * PREVIEW_IMAGE_HEIGHT * 4).fill(link.title.length);
  await storePreviewImage(env.DB, link.slug, { title: link.title, destination: link.destination,
    origin: ORIGIN, segment: compressPreviewSection(pixels, PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT) });
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
    expect(html).toContain(`property="og:image" content="${ORIGIN}/_preview/notes.png"`);
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    const alternate = await SELF.fetch("http://127.0.0.1:5173/notes");
    expect(alternate.status).toBe(200);
    expect(await alternate.text()).toContain("Continue to destination");
  });

  it("serves a fallback to sharing crawlers while keeping browser redirects immediate", async () => {
    await create("notes");
    const outbound = vi.fn(async () => new Response("<html><head><title>Notes</title></head></html>", {
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", outbound);
    const browser = await SELF.fetch(`${ORIGIN}/notes`, { redirect: "manual" });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("Vary")).toBe("User-Agent");
    expect(outbound).not.toHaveBeenCalled();
    const crawler = await SELF.fetch(`${ORIGIN}/notes`, {
      headers: { "User-Agent": "Discordbot/2.0", Cookie: "private=session", Authorization: "Bearer private" }, redirect: "manual",
    });
    expect(crawler.status).toBe(200);
    expect(crawler.headers.get("Location")).toBeNull();
    expect(crawler.headers.get("Cache-Control")).toBe("no-store");
    expect(crawler.headers.get("Vary")).toBe("User-Agent");
    expect(await crawler.text()).toContain(`${ORIGIN}/_preview/notes.png`);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound.mock.calls[0]).toEqual([new URL(DESTINATION), expect.objectContaining({
      redirect: "manual", headers: { Accept: "text/html", "User-Agent": "Ratatoskr/1.0 (link preview metadata)" },
    })]);
  });

  it.each(["og:image", "twitter:image"])("preserves destinations with %s images", async (property) => {
    await create("notes");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html><head><meta property="${property}" content="/cover.png"></head></html>`, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })));
    const response = await SELF.fetch(`${ORIGIN}/notes`, { headers: { "User-Agent": "Twitterbot/1.0" }, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(DESTINATION);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("preserves crawler redirects when destination metadata is in an implicit head", async () => {
    await create("notes");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<!doctype html><html><meta charset="utf-8"><title>Article</title><meta property="og:image" content="https://example.com/cover.png"><body>Article</body></html>', {
      headers: { "Content-Type": "text/html" },
    })));
    const response = await SELF.fetch(`${ORIGIN}/notes`, { headers: { "User-Agent": "Discordbot" }, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(DESTINATION);
  });

  it("serves real PNGs from stored data and never fetches destinations for explicit previews or images", async () => {
    await create("notes");
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    expect((await SELF.fetch(`${ORIGIN}/notes+`, { headers: { "User-Agent": "Slackbot-LinkExpanding" } })).status).toBe(200);
    const response = await SELF.fetch(`${ORIGIN}/_preview/notes.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const png = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(png.buffer);
    expect(header.getUint32(16)).toBe(600);
    expect(header.getUint32(20)).toBe(315);
    const head = await SELF.fetch(`${ORIGIN}/_preview/notes.png`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("image/png");
    expect(await head.text()).toBe("");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("updates images after edits and withdraws every preview route for unavailable links", async () => {
    await create("notes");
    const original = await (await SELF.fetch(`${ORIGIN}/_preview/notes.png`)).arrayBuffer();
    await env.DB.prepare("UPDATE links SET title = 'Changed title' WHERE slug = 'notes'").run();
    expect((await SELF.fetch(`${ORIGIN}/_preview/notes.png`)).status).toBe(503);
    await uploadImage({ ...linkSchema.parse(await (await SELF.fetch(`${ORIGIN}/api/links/notes`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ title: "Changed title" }),
    })).json()), title: "Changed title" });
    const edited = await (await SELF.fetch(`${ORIGIN}/_preview/notes.png`)).arrayBuffer();
    expect(new Uint8Array(edited)).not.toEqual(new Uint8Array(original));
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    for (const change of ["status = 'revoked'", "status = 'active', expires_at = '2000-01-01T00:00:00.000Z'", "status = 'deleted', destination = NULL, title = '', expires_at = NULL"]) {
      await env.DB.prepare(`UPDATE links SET ${change} WHERE slug = 'notes'`).run();
      const status = change.startsWith("status = 'deleted'") ? 404 : 410;
      for (const path of ["/notes", "/notes+", "/_preview/notes.png"]) {
        const response = await SELF.fetch(`${ORIGIN}${path}`, { headers: { "User-Agent": "Discordbot" }, redirect: "manual" });
        expect(response.status).toBe(status);
        expect(await response.text()).not.toContain(DESTINATION);
      }
    }
    expect((await SELF.fetch(`${ORIGIN}/_preview/missing.png`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/_preview/notes.png/extra`)).status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("retains the previous image when an edit's audit write rolls back", async () => {
    await create("notes");
    const before = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/_preview/notes.png`)).arrayBuffer());
    await env.DB.prepare("CREATE TRIGGER reject_image_edit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
    try {
      const response = await SELF.fetch(`${ORIGIN}/api/links/notes`, { method: "PATCH",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Rolled back" }) });
      expect(response.status).toBe(503);
      const after = await SELF.fetch(`${ORIGIN}/_preview/notes.png`);
      expect(after.status).toBe(200);
      expect(new Uint8Array(await after.arrayBuffer())).toEqual(before);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_image_edit").run();
    }
  });

  it("rejects delayed image uploads after edits or deletion and never serves a previous body", async () => {
    const link = await create("notes");
    const pixels = new Uint8Array(PREVIEW_IMAGE_WIDTH * PREVIEW_IMAGE_HEIGHT * 4);
    const upload = { title: link.title, destination: link.destination, origin: ORIGIN,
      segment: compressPreviewSection(pixels, PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT) };
    const send = (body = upload, origin = ORIGIN) => SELF.fetch(`${ORIGIN}/api/links/notes/image`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body),
    });
    expect((await send()).status).toBe(204);
    expect((await send(upload, "https://attacker.example")).status).toBe(403);
    expect((await send({ ...upload, origin: "https://old.example" })).status).toBe(409);
    await env.DB.prepare("UPDATE links SET destination = 'https://example.com/new' WHERE slug = 'notes'").run();
    expect((await send()).status).toBe(409);
    for (const method of ["GET", "HEAD"]) {
      const response = await SELF.fetch(`${ORIGIN}/_preview/notes.png`, { method });
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await SELF.fetch(`${ORIGIN}/notes`, { redirect: "manual" })).headers.get("Location")).toBe("https://example.com/new");
    await SELF.fetch(`${ORIGIN}/api/links/notes`, { method: "DELETE", headers: { Origin: ORIGIN } });
    expect((await send()).status).toBe(409);
    expect(await env.DB.prepare("SELECT slug FROM preview_images WHERE slug = 'notes'").first()).toBeNull();
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
