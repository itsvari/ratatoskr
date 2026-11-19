import { describe, expect, it } from "vitest";
import { ApplicationError } from "../src/errors";
import { readBoundedBytes } from "../src/request-body";

const MAXIMUM_BYTES = 8;

function streamOf(chunks: readonly Uint8Array[], onCancel: () => void | Promise<void> = () => {}, onPull: () => void = () => {}): ReadableStream<Uint8Array> {
  let nextIndex = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull();
      const chunk = chunks[nextIndex];
      nextIndex += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel: onCancel,
  });
}

describe("Bounded request body reader", () => {
  it("joins chunks that stay within the limit", async () => {
    const bytes = await readBoundedBytes(streamOf([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])]), MAXIMUM_BYTES);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("cancels the stream and answers 413 as soon as the limit is exceeded", async () => {
    let cancelled = false;
    let pulls = 0;
    const oversizedChunks = Array.from({ length: 100 }, () => new Uint8Array(MAXIMUM_BYTES));
    const failure = await readBoundedBytes(streamOf(oversizedChunks, () => { cancelled = true; }, () => { pulls += 1; }), MAXIMUM_BYTES)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(oversizedChunks.length);
  });

  it("joins many one-byte chunks and accepts exactly the limit", async () => {
    const chunkCount = 5000;
    const bytes = await readBoundedBytes(streamOf(Array.from({ length: chunkCount }, (_, index) => new Uint8Array([index % 256]))), chunkCount);
    expect(bytes.byteLength).toBe(chunkCount);
    expect(bytes.every((value, index) => value === index % 256)).toBe(true);
  });

  it("accepts a single chunk of exactly the limit and refuses one byte more", async () => {
    const exact = await readBoundedBytes(streamOf([new Uint8Array(MAXIMUM_BYTES).fill(7)]), MAXIMUM_BYTES);
    expect([...exact]).toEqual(new Array<number>(MAXIMUM_BYTES).fill(7));
    const failure = await readBoundedBytes(streamOf([new Uint8Array(MAXIMUM_BYTES + 1)]), MAXIMUM_BYTES).then(() => null, (error: unknown) => error);
    expect((failure as ApplicationError).status).toBe(413);
  });

  it("returns an empty array for an empty body", async () => {
    expect((await readBoundedBytes(streamOf([]), MAXIMUM_BYTES)).byteLength).toBe(0);
  });

  it("still answers 413 when cancelling the stream rejects", async () => {
    const oversizedChunks = [new Uint8Array(MAXIMUM_BYTES + 1)];
    const failure = await readBoundedBytes(streamOf(oversizedChunks, () => Promise.reject(new Error("cancel failed"))), MAXIMUM_BYTES)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).status).toBe(413);
  });
});
