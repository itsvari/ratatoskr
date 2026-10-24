import type { Resvg } from "@resvg/resvg-wasm";
import font from "./assets/inter.ttf.bin";
import { fallbackFontsForText } from "./assets/fallback-fonts";
import { createSvgRenderer } from "./preview-wasm";

export async function createPreviewRenderer(svg: string): Promise<InstanceType<typeof Resvg>> {
  return createSvgRenderer(svg, [font, ...fallbackFontsForText(svg)].map((buffer) => new Uint8Array(buffer)));
}
