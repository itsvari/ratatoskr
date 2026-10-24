import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { encodePng } from "../src/png";

describe("PNG encoding", () => {
  it("writes valid chunk checksums and losslessly encodes RGBA pixels including transparency", () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128, 10, 20, 30, 255]);
    const png = encodePng(pixels, 2, 2);
    const view = new DataView(png.buffer);
    const chunks = new Map<string, Uint8Array>();
    for (let offset = 8; offset < png.byteLength;) {
      const length = view.getUint32(offset);
      const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
      expect(view.getUint32(offset + length + 8)).toBe(crc32(png.subarray(offset + 4, offset + length + 8)));
      chunks.set(type, png.slice(offset + 8, offset + 8 + length));
      offset += length + 12;
    }
    expect([...chunks.keys()]).toEqual(["IHDR", "IDAT", "IEND"]);
    const scanlines = inflateSync(chunks.get("IDAT")!);
    expect([...scanlines]).toEqual([0, ...pixels.subarray(0, 8), 0, ...pixels.subarray(8)]);
  });
});
