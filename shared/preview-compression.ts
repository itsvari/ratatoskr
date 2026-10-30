import { Deflate, Z_SYNC_FLUSH } from "pako";
import { PREVIEW_SCANLINE_BYTES, type PreviewSegment } from "./preview-image";

export function compressPreviewSection(pixels: Uint8Array, startRow: number, endRow: number): PreviewSegment {
  const strideBytes = PREVIEW_SCANLINE_BYTES - 1;
  const scanlines = new Uint8Array((endRow - startRow) * PREVIEW_SCANLINE_BYTES);
  for (let row = startRow; row < endRow; row += 1) {
    scanlines.set(pixels.subarray(row * strideBytes, (row + 1) * strideBytes), (row - startRow) * PREVIEW_SCANLINE_BYTES + 1);
  }
  const compressor = new Deflate({ raw: true, level: 1 });
  const chunks: Uint8Array[] = [];
  compressor.onData = (chunk) => chunks.push(chunk);
  compressor.push(scanlines, Z_SYNC_FLUSH);
  if (compressor.err) throw new Error("Could not compress the preview image.");
  const compressed = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offsetBytes = 0;
  for (const chunk of chunks) {
    compressed.set(chunk, offsetBytes);
    offsetBytes += chunk.length;
  }
  let low = 1;
  let high = 0;
  const modulus = 65521;
  for (const byte of scanlines) {
    low = (low + byte) % modulus;
    high = (high + low) % modulus;
  }
  const characters = Array.from(compressed, (byte) => String.fromCharCode(byte)).join("");
  return { compressed: btoa(characters), checksum: ((high << 16) | low) >>> 0 };
}
