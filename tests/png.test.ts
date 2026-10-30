import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compressPreviewSection } from "../shared/preview-compression";
import { PREVIEW_IMAGE_WIDTH, PREVIEW_IMAGE_HEIGHT, PREVIEW_HEADER_HEIGHT, PREVIEW_SCANLINE_BYTES } from "../shared/preview-image";
import { assemblePreviewPng, encodePng } from "../src/png";

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

it("joins independently rendered sections with a valid zlib checksum and exact pixels", () => {
  const pixels = new Uint8Array(PREVIEW_IMAGE_WIDTH * PREVIEW_IMAGE_HEIGHT * 4);
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 37 + Math.floor(index / 97)) % 256;
  const png = assemblePreviewPng(compressPreviewSection(pixels, 0, PREVIEW_HEADER_HEIGHT),
    compressPreviewSection(pixels, PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT));
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const compressedLength = view.getUint32(33);
  const decoded = new Uint8Array(inflateSync(png.subarray(41, 41 + compressedLength)));
  expect(decoded.length).toBe(PREVIEW_SCANLINE_BYTES * PREVIEW_IMAGE_HEIGHT);
  for (let row = 0; row < PREVIEW_IMAGE_HEIGHT; row += 1) {
    expect(decoded[row * PREVIEW_SCANLINE_BYTES]).toBe(0);
    expect(decoded.subarray(row * PREVIEW_SCANLINE_BYTES + 1, (row + 1) * PREVIEW_SCANLINE_BYTES))
      .toEqual(pixels.subarray(row * PREVIEW_IMAGE_WIDTH * 4, (row + 1) * PREVIEW_IMAGE_WIDTH * 4));
  }
});
