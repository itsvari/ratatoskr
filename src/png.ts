import { crc32, deflateSync } from "node:zlib";

function uint32(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function chunk(type: string, bytes: Uint8Array): readonly Uint8Array[] {
  const data = new Uint8Array(4 + bytes.byteLength);
  data.set(new TextEncoder().encode(type));
  data.set(bytes, 4);
  return [uint32(bytes.byteLength), data, uint32(crc32(data))];
}

export function encodePng(pixels: Uint8Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  const stride = width * 4;
  if (pixels.byteLength !== stride * height) throw new Error("Invalid RGBA image dimensions.");
  const scanlines = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    // Filter 0 and native level-1 deflate trade a few KiB for much less CPU than Wasm PNG compression.
    scanlines.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  header.set(uint32(width));
  header.set(uint32(height), 4);
  header[8] = 8;
  header[9] = 6;
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk("IHDR", header),
    ...chunk("IDAT", deflateSync(scanlines, { level: 1 })), ...chunk("IEND", new Uint8Array())];
  const png = new Uint8Array(chunks.reduce((total, bytes) => total + bytes.byteLength, 0));
  let offset = 0;
  for (const bytes of chunks) {
    png.set(bytes, offset);
    offset += bytes.byteLength;
  }
  return png;
}
