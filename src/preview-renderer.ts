import { initWasm, Resvg } from "@resvg/resvg-wasm";
import rendererModule from "@resvg/resvg-wasm/index_bg.wasm";
import font from "./assets/inter.ttf.bin";

// Keep initialisation separate from the template so Vite can hot-reload its design.
let rendererReady: Promise<void> | undefined;

export async function createPreviewRenderer(svg: string): Promise<InstanceType<typeof Resvg>> {
  rendererReady ??= initWasm(rendererModule);
  await rendererReady;
  return new Resvg(svg, {
    font: { fontBuffers: [new Uint8Array(font)], defaultFontFamily: "Inter" },
  });
}
