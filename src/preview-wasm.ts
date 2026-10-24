import { initWasm, Resvg } from "@resvg/resvg-wasm";
import rendererModule from "@resvg/resvg-wasm/index_bg.wasm";

// Font and template edits can hot-reload without reinitialising the package's Wasm singleton.
let rendererReady: Promise<void> | undefined;

export async function createSvgRenderer(svg: string, fontBuffers: Uint8Array[]): Promise<InstanceType<typeof Resvg>> {
  rendererReady ??= initWasm(rendererModule);
  await rendererReady;
  return new Resvg(svg, { font: { fontBuffers, defaultFontFamily: "Inter" } });
}
