import { previewSections } from "./preview-fixture";
import { storePreviewImage } from "../src/preview-image";
import { env, SELF, createExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY_NAME, MAXIMUM_DISPLAY_NAME_LENGTH, sessionSchema, siteSettingsSchema } from "../shared/contracts";
import { getSiteSettings, updateSiteSettings } from "../src/settings";
import { brandAdminPage } from "../src/preview";
import { renderPreviewSvg } from "../src/preview-template";
import worker from "../src/index";

const ORIGIN = "http://localhost:5173";
const administrator = { subject: "settings-owner", email: "owner@example.com" };

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM preview_images"),
    env.DB.prepare("DELETE FROM site_settings_audit"),
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM administrators"),
    env.DB.prepare("UPDATE site_settings SET display_name = 'Ratatoskr', preview_header = NULL WHERE singleton = 1"),
  ]);
});

async function save(displayName: unknown, origin = ORIGIN) {
  const previewHeader = (await previewSections(siteSettingsSchema.safeParse({ displayName }).success && typeof displayName === "string" ? displayName.trim() : "invalid")).header;
  return SELF.fetch(`${ORIGIN}/api/settings`, {
    method: "PATCH", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ displayName, previewHeader }),
  });
}

describe("Site settings", () => {
  it("starts with the default name and persists trimmed changes with an atomic audit", async () => {
    expect(await getSiteSettings(env.DB)).toEqual({ displayName: DEFAULT_DISPLAY_NAME });
    expect(await updateSiteSettings(env.DB, administrator, { displayName: "  My Links  ", previewHeader: (await previewSections("My Links")).header })).toEqual({ displayName: "My Links" });
    expect(await getSiteSettings(env.DB)).toEqual({ displayName: "My Links" });
    expect(await env.DB.prepare("SELECT actor_subject, display_name FROM site_settings_audit").first())
      .toEqual({ actor_subject: administrator.subject, display_name: "My Links" });
    await updateSiteSettings(env.DB, administrator, { displayName: "My Links", previewHeader: (await previewSections("My Links")).header });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM site_settings_audit").first("count")).toBe(1);
  });

  it("rolls back settings and administrator creation when the audit fails", async () => {
    await env.DB.prepare("CREATE TRIGGER reject_settings_audit BEFORE INSERT ON site_settings_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
    try {
      await expect(updateSiteSettings(env.DB, administrator, { displayName: "Withdrawn change", previewHeader: (await previewSections("Withdrawn change")).header })).rejects.toThrow();
      expect(await getSiteSettings(env.DB)).toEqual({ displayName: DEFAULT_DISPLAY_NAME });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM administrators").first("count")).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_settings_audit").run();
    }
  });

  it.each(["", " ", "x".repeat(MAXIMUM_DISPLAY_NAME_LENGTH + 1), "Name\nName", "Name\u0000", "Name\ud800", "Name\uffff", 123, null])("rejects invalid names: %j", async (displayName) => {
    expect((await save(displayName)).status).toBe(400);
    expect(await getSiteSettings(env.DB)).toEqual({ displayName: DEFAULT_DISPLAY_NAME });
  });

  it("rejects unknown fields and cross-origin or originless writes", async () => {
    expect((await save("Wrong origin", "https://attacker.example")).status).toBe(403);
    expect((await SELF.fetch(`${ORIGIN}/api/settings`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "No origin" }),
    })).status).toBe(403);
    expect((await SELF.fetch(`${ORIGIN}/api/settings`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ displayName: "Name", adminOrigin: "https://attacker.example" }),
    })).status).toBe(400);
  });

  it("requires generated branding for a custom name and leaves the previous settings intact", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/settings`, { method: "PATCH",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ displayName: "Unrendered name" }) });
    expect(response.status).toBe(400);
    expect(await getSiteSettings(env.DB)).toEqual({ displayName: DEFAULT_DISPLAY_NAME });
    expect(await env.DB.prepare("SELECT preview_header FROM site_settings WHERE singleton = 1").first("preview_header")).toBeNull();
  });

  it("requires Access on the management host and hides settings on public hosts", async () => {
    const environment = { ...env, SHORT_ORIGIN: "https://links.example.com", ADMIN_ORIGIN: "https://admin.example.com",
      PREVIEW_ORIGIN: "https://preview.example.com", LOCAL_DEVELOPMENT: "false" };
    for (const hostname of ["links", "preview", "admin"]) {
      const request = new Request(`https://${hostname}.example.com/api/settings`, {
        method: "PATCH", headers: { Origin: "https://admin.example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Unauthorised" }),
      });
      const response = await worker.fetch(request, environment, createExecutionContext());
      expect(response.status).toBe(hostname === "admin" ? 401 : 404);
    }
    expect(await getSiteSettings(env.DB)).toEqual({ displayName: DEFAULT_DISPLAY_NAME });
  });

  it("updates session data, public pages, preview metadata, PNGs and export names", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/links`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ slug: "branding", destination: "http://192.0.2.1/notes", title: "Notes" }),
    })).status).toBe(201);
    await storePreviewImage(env.DB, "branding", { title: "Notes", destination: "http://192.0.2.1/notes", origin: ORIGIN,
      segment: (await previewSections("Ratatoskr")).body });
    const before = new Uint8Array(await (await SELF.fetch(`${ORIGIN}/_preview/branding.png`)).arrayBuffer());
    const response = await save("  My Links & Notes  ");
    expect(response.status).toBe(200);
    expect(siteSettingsSchema.parse(await response.json())).toEqual({ displayName: "My Links & Notes" });
    expect(siteSettingsSchema.parse(await (await SELF.fetch(`${ORIGIN}/api/settings`)).json())).toEqual({ displayName: "My Links & Notes" });
    expect(sessionSchema.parse(await (await SELF.fetch(`${ORIGIN}/api/session`)).json()).displayName).toBe("My Links & Notes");
    for (const path of ["/", "/branding+", "/missing+"]) {
      const html = await (await SELF.fetch(`${ORIGIN}${path}`)).text();
      expect(html).toContain("My Links &amp; Notes");
      expect(html).not.toContain("Ratatoskr");
    }
    const crawler = await SELF.fetch(`${ORIGIN}/branding`, { headers: { "User-Agent": "Discordbot" } });
    expect(await crawler.text()).toContain('property="og:site_name" content="My Links &amp; Notes"');
    const after = await SELF.fetch(`${ORIGIN}/_preview/branding.png`);
    expect(after.headers.get("Cache-Control")).toBe("no-store");
    expect(new Uint8Array(await after.arrayBuffer())).not.toEqual(before);
    expect((await SELF.fetch(`${ORIGIN}/api/export`)).headers.get("Content-Disposition")).toContain("my-links-notes-links.json");
    await save(DEFAULT_DISPLAY_NAME);
    expect(sessionSchema.parse(await (await SELF.fetch(`${ORIGIN}/api/session`)).json()).displayName).toBe(DEFAULT_DISPLAY_NAME);
  });

  it("escapes names in HTML, SVG and the admin document without treating text as markup", async () => {
    const displayName = '<script>alert("x")</script> & Links';
    expect((await save(displayName)).status).toBe(200);
    const home = await (await SELF.fetch(ORIGIN)).text();
    expect(home).toContain("&lt;script&gt;");
    expect(home).not.toContain('<script>alert("x")</script>');
    const admin = await brandAdminPage(new Response("<html><head><title>Original</title></head><body><noscript>Original</noscript></body></html>"), displayName).text();
    expect(admin).toContain("&lt;script&gt;");
    expect(admin).not.toContain('<script>alert("x")</script>');
    const svg = renderPreviewSvg({ slug: "name", title: "", destination: "https://example.com", status: "active",
      expiresAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, ORIGIN, displayName);
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toContain('<script>alert("x")</script>');
  });
});
