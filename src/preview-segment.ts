import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import { PREVIEW_FINAL_DEFLATE_BLOCK, PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT, PREVIEW_SCANLINE_BYTES,
  previewSegmentSchema, type PreviewSegment } from "../shared/preview-image";
import { ApplicationError } from "./errors";

const SYNC_FLUSH_SUFFIX = new Uint8Array([0, 0, 255, 255]);
const ADLER_MODULUS = 65521;

export function validatePreviewSegment(segment: PreviewSegment, section: "header" | "body"): PreviewSegment {
  try {
    if (!previewSegmentSchema.safeParse(segment).success) throw new Error();
    const compressed = Buffer.from(segment.compressed, "base64");
    if (compressed.toString("base64") !== segment.compressed || compressed.length < SYNC_FLUSH_SUFFIX.length ||
      !SYNC_FLUSH_SUFFIX.every((byte, index) => compressed[compressed.length - SYNC_FLUSH_SUFFIX.length + index] === byte)) {
      throw new Error();
    }
    const input = Buffer.concat([compressed, PREVIEW_FINAL_DEFLATE_BLOCK]);
    const rows = section === "header" ? PREVIEW_HEADER_HEIGHT : PREVIEW_IMAGE_HEIGHT - PREVIEW_HEADER_HEIGHT;
    const expectedLengthBytes = rows * PREVIEW_SCANLINE_BYTES;
    const result: unknown = inflateRawSync(input, { info: true, maxOutputLength: expectedLengthBytes });
    if (typeof result !== "object" || result === null || !("buffer" in result) || !Buffer.isBuffer(result.buffer) ||
      !("engine" in result) || typeof result.engine !== "object" || result.engine === null ||
      !("bytesWritten" in result.engine) || result.engine.bytesWritten !== input.length ||
      result.buffer.length !== expectedLengthBytes) throw new Error();
    let low = 1;
    let high = 0;
    let index = 0;
    for (const byte of result.buffer) {
      if (index % PREVIEW_SCANLINE_BYTES === 0 && byte !== 0) throw new Error();
      low = (low + byte) % ADLER_MODULUS;
      high = (high + low) % ADLER_MODULUS;
      index += 1;
    }
    if ((((high << 16) | low) >>> 0) !== segment.checksum) throw new Error();
    return segment;
  } catch {
    throw new ApplicationError("Invalid preview image section.", 400);
  }
}
