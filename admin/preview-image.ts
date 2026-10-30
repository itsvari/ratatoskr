import { initWasm, Resvg } from "@resvg/resvg-wasm";
import rendererUrl from "@resvg/resvg-wasm/index_bg.wasm?url";
import fontUrl from "../src/assets/inter.ttf.bin?url";
import type { Link } from "../shared/contracts";
import { PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT } from "../shared/preview-image";
import { compressPreviewSection } from "../shared/preview-compression";
import { renderPreviewSvg } from "../src/preview-template";

let ready: Promise<ArrayBuffer> | undefined;
let wasmReady: Promise<void> | undefined;
async function loadRenderer(): Promise<ArrayBuffer> {
  wasmReady ??= initWasm(fetch(rendererUrl));
  await wasmReady;
  const response = await fetch(fontUrl);
  if (!response.ok) throw new Error("Could not load the preview font. Try saving again.");
  return response.arrayBuffer();
}

export async function generateLinkPreview(link: Link, shortOrigin: string) {
  ready ??= loadRenderer().catch((error: unknown) => { ready = undefined; throw error; });
  const font = await ready;
  const renderer = new Resvg(renderPreviewSvg(link, shortOrigin), {
    font: { fontBuffers: [new Uint8Array(font)], defaultFontFamily: "Inter" },
  });
  try {
    const image = renderer.render();
    try { return compressPreviewSection(image.pixels, PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT); }
    finally { image.free(); }
  } finally { renderer.free(); }
}
