import { ApplicationError } from "./errors";

const INITIAL_BUFFER_BYTES = 4096;
const BUFFER_GROWTH_FACTOR = 2;

// reads incrementally and cancels at the limit so an oversized request is never fully buffered before it is refused.
// one buffer that grows geometrically and never beyond the limit keeps memory proportional to the bytes received, however many chunks carry them.
export async function readBoundedBytes(body: ReadableStream<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
  const reader = body.getReader();
  let buffer = new Uint8Array(Math.min(INITIAL_BUFFER_BYTES, maximumBytes));
  let receivedBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const requiredBytes = receivedBytes + result.value.byteLength;
    if (requiredBytes > maximumBytes) {
      // the refusal does not depend on the stream tearing down cleanly, so a failing cancel must not replace it.
      await reader.cancel().catch(() => undefined);
      throw new ApplicationError("Request body is too large.", 413);
    }
    if (requiredBytes > buffer.byteLength) {
      const grown = new Uint8Array(Math.min(maximumBytes, Math.max(buffer.byteLength * BUFFER_GROWTH_FACTOR, requiredBytes)));
      grown.set(buffer.subarray(0, receivedBytes));
      buffer = grown;
    }
    buffer.set(result.value, receivedBytes);
    receivedBytes = requiredBytes;
  }
  return receivedBytes === buffer.byteLength ? buffer : buffer.slice(0, receivedBytes);
}
