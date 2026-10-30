import { previewSections } from "./preview-fixture";
import { storePreviewImage } from "../src/preview-image";
import type { Link } from "../shared/contracts";
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Resvg } from "@resvg/resvg-wasm";
import { inflateSync } from "node:zlib";
import { renderPreviewSvg } from "../src/preview-template";
import { createPreviewRenderer } from "../src/preview-renderer";
import { encodePng } from "../src/png";
import { fallbackFontsForText } from "../src/assets/fallback-fonts";
import inter from "../src/assets/inter.ttf.bin";
import { renderPreviewText } from "../src/preview-text";

const ORIGIN = "http://localhost:5173";
const link = { slug: "international", title: "Useful links", destination: "https://example.com/notes", status: "active",
  expiresAt: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } as const;

async function renderPreviewImage(link: Link, shortOrigin: string, name: string): Promise<Response> {
  const renderer = await createPreviewRenderer(renderPreviewSvg(link, shortOrigin, name));
  try {
    const image = renderer.render();
    try { return new Response(encodePng(image.pixels, image.width, image.height)); }
    finally { image.free(); }
  } finally { renderer.free(); }
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM preview_images"), env.DB.prepare("DELETE FROM site_settings_audit"), env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM links"), env.DB.prepare("DELETE FROM administrators"),
    env.DB.prepare("UPDATE site_settings SET display_name = 'Ratatoskr' WHERE singleton = 1"),
  ]);
});

describe("International preview fonts", () => {
  it("selects only the needed CJK pages and keeps Arabic shaping in one complete font", () => {
    expect(fallbackFontsForText("Ratatoskr")).toHaveLength(0);
    expect(fallbackFontsForText("我的链接")).toHaveLength(4);
    expect(fallbackFontsForText("روابطي")).toHaveLength(1);
    expect(fallbackFontsForText("我的链接 我的链接")).toHaveLength(4);
  });

  it.each(["我的链接", "روابطي"])("renders %s using glyphs rather than Inter missing-glyph placeholders", async (name) => {
    const png = new Uint8Array(await (await renderPreviewImage(link, ORIGIN, name)).arrayBuffer());
    const renderer = new Resvg(renderPreviewSvg(link, ORIGIN, name), {
      font: { fontBuffers: [new Uint8Array(inter)], defaultFontFamily: "Inter" },
    });
    try {
      const missingGlyphImage = renderer.render();
      try {
        const missing = encodePng(missingGlyphImage.pixels, missingGlyphImage.width, missingGlyphImage.height);
        expect(png).not.toEqual(missing);
      } finally { missingGlyphImage.free(); }
    } finally { renderer.free(); }
    const header = new DataView(png.buffer);
    expect(header.getUint32(16)).toBe(600);
    expect(header.getUint32(20)).toBe(315);
  });

  it("applies Arabic joining instead of drawing isolated letters", async () => {
    const joined = new Uint8Array(await (await renderPreviewImage(link, ORIGIN, "روابطي")).arrayBuffer());
    const isolated = new Uint8Array(await (await renderPreviewImage(link, ORIGIN, Array.from("روابطي").join("\u200c"))).arrayBuffer());
    expect(joined).not.toEqual(isolated);
  });

  it("selects fonts per run in mixed CJK/Arabic names without separating joining marks", () => {
    const options = { x: 100, y: 106, fontSize: 28, maximumWidth: 1028, fontWeight: 600 };
    const mixed = renderPreviewText("我的链接 · رَوَابِطِي", options);
    expect(mixed).toContain('>رَوَابِطِي</text>');
    expect(mixed).toContain('font-family="Preview Arabic"');
    expect(mixed).toContain('font-family="Preview CJK 62"');
    expect(renderPreviewText('<img src="x">', options)).toContain("&lt;img src=&quot;x&quot;&gt;");
    const numbered = renderPreviewText("روابطي 123", options);
    expect(numbered.indexOf(">123</text>")).toBeLessThan(numbered.indexOf(">روابطي</text>"));
  });

  it("keeps mixed-script text visible in the actual PNG header", async () => {
    const png = new Uint8Array(await (await renderPreviewImage(link, ORIGIN, "我的链接 · روابطي")).arrayBuffer());
    const view = new DataView(png.buffer);
    let compressed: Uint8Array | undefined;
    for (let offset = 8; offset < png.byteLength;) {
      const length = view.getUint32(offset);
      if (new TextDecoder().decode(png.subarray(offset + 4, offset + 8)) === "IDAT") compressed = png.subarray(offset + 8, offset + length + 8);
      offset += length + 12;
    }
    expect(compressed).toBeDefined();
    const pixels = inflateSync(compressed!);
    let purplePixels = 0;
    for (let y = 32; y < 65; y += 1) {
      for (let x = 45; x < 550; x += 1) {
        const offset = y * (600 * 4 + 1) + 1 + x * 4;
        const [red = 0, green = 0, blue = 0] = pixels.subarray(offset, offset + 3);
        if (red > green + 10 && blue > green + 30) purplePixels += 1;
      }
    }
    expect(purplePixels).toBeGreaterThan(100);
  });

  it("persists international names, changes image bytes immediately and withdraws cached images", async () => {
    const created = await SELF.fetch(`${ORIGIN}/api/links`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ slug: link.slug, title: link.title, destination: link.destination }),
    });
    expect(created.status).toBe(201);
    await storePreviewImage(env.DB, link.slug, { title: link.title, destination: link.destination, origin: ORIGIN,
      segment: (await previewSections("Ratatoskr", link)).body });
    const images: Uint8Array[] = [];
    for (const displayName of ["我的链接", "روابطي"]) {
      const saved = await SELF.fetch(`${ORIGIN}/api/settings`, {
        method: "PATCH", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ displayName, previewHeader: (await previewSections(displayName)).header }),
      });
      expect(saved.status).toBe(200);
      expect((await SELF.fetch(`${ORIGIN}/${link.slug}+`)).headers.get("Cache-Control")).toBe("no-store");
      const response = await SELF.fetch(`${ORIGIN}/_preview/${link.slug}.png`);
      expect(response.status).toBe(200);
      images.push(new Uint8Array(await response.arrayBuffer()));
    }
    expect(images[0]).not.toEqual(images[1]);
    await env.DB.prepare("UPDATE links SET status = 'revoked' WHERE slug = ?").bind(link.slug).run();
    expect((await SELF.fetch(`${ORIGIN}/_preview/${link.slug}.png`)).status).toBe(410);
  });
});
