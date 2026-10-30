import { initWasm, Resvg } from "@resvg/resvg-wasm";
import rendererUrl from "@resvg/resvg-wasm/index_bg.wasm?url";
import fontUrl from "../src/assets/inter.ttf.bin?url";
import { fallbackFontUrlsForText } from "../src/assets/preview-font-urls";
import type { Link } from "../shared/contracts";
import { PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT } from "../shared/preview-image";
import { compressPreviewSection } from "../shared/preview-compression";
import { renderPreviewSvg } from "../src/preview-template";

let ready: Promise<ArrayBuffer> | undefined;
let wasmReady: Promise<void> | undefined;
async function loadRenderer(): Promise<ArrayBuffer> {
  wasmReady ??= initWasm(fetch(rendererUrl)).catch((error: unknown) => { wasmReady = undefined; throw error; });
  await wasmReady;
  const response = await fetch(fontUrl);
  if (!response.ok) throw new Error("Could not load the preview font. Try saving again.");
  return response.arrayBuffer();
}

const fallbackFonts = new Map<string, Promise<Uint8Array>>();
function loadFallbackFont(url: string): Promise<Uint8Array> {
  const existing = fallbackFonts.get(url);
  if (existing) return existing;
  const loading = fetch(url).then(async (response) => {
    if (!response.ok) throw new Error("Could not load a preview font. Try saving again.");
    return new Uint8Array(await response.arrayBuffer());
  }).catch((error: unknown) => { fallbackFonts.delete(url); throw error; });
  fallbackFonts.set(url, loading);
  return loading;
}

export async function generatePreviewSection(link: Link, shortOrigin: string, displayName: string, section: "header" | "body") {
  ready ??= loadRenderer().catch((error: unknown) => { ready = undefined; throw error; });
  const font = await ready;
  const svg = renderPreviewSvg(link, shortOrigin, displayName);
  const fallbacks = await Promise.all(fallbackFontUrlsForText(svg).map(loadFallbackFont));
  const renderer = new Resvg(svg, {
    font: { fontBuffers: [new Uint8Array(font), ...fallbacks], defaultFontFamily: "Inter" },
  });
  try {
    const image = renderer.render();
    try { return compressPreviewSection(image.pixels, section === "header" ? 0 : PREVIEW_HEADER_HEIGHT, section === "header" ? PREVIEW_HEADER_HEIGHT : PREVIEW_IMAGE_HEIGHT); }
    finally { image.free(); }
  } finally { renderer.free(); }
}

export async function generateLinkPreview(link: Link, shortOrigin: string) {
  return generatePreviewSection(link, shortOrigin, "Ratatoskr", "body");
}

export async function generatePreviewHeader(displayName: string) {
  return generatePreviewSection({ slug: "example", title: "", destination: "https://example.com",
    status: "active", expiresAt: null, createdAt: "", updatedAt: "" }, "https://example.com", displayName, "header");
}
