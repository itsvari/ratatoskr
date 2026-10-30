import { readFile, writeFile } from "node:fs/promises";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { renderPreviewSvg } from "../src/preview-template";
import { compressPreviewSection } from "../shared/preview-compression";
import { PREVIEW_HEADER_HEIGHT } from "../shared/preview-image";

await initWasm(await readFile("node_modules/@resvg/resvg-wasm/index_bg.wasm"));
const renderer = new Resvg(renderPreviewSvg({ slug: "example", title: "", destination: "https://example.com",
  status: "active", expiresAt: null, createdAt: "", updatedAt: "" }, "https://example.com"), {
  font: { fontBuffers: [await readFile("src/assets/inter.ttf.bin")], defaultFontFamily: "Inter" },
});
try {
  const image = renderer.render();
  try { await writeFile("src/assets/preview-header.json", `${JSON.stringify(compressPreviewSection(image.pixels, 0, PREVIEW_HEADER_HEIGHT))}\n`); }
  finally { image.free(); }
} finally { renderer.free(); }
