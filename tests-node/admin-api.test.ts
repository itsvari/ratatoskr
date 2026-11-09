import { strict as assert } from "node:assert";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["admin/api.ts"], bundle: true, platform: "node", format: "esm", plugins: [{ name: "preview-stub", setup(builder) { builder.onResolve({ filter: /^\.\/preview-image$/ }, (arguments_) => arguments_.importer.endsWith("admin/api.ts") ? { path: "preview", namespace: "stub" } : undefined); builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export const generatePreviewHeader = () => {}; export const generateLinkPreview = () => {};" })); } }], write: false });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString("base64")}`;
const { fetchSession }: typeof import("../admin/api.ts") = await import(moduleUrl);

test("aborting a response body preserves AbortError for success and failure", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [200, 400]) {
      globalThis.fetch = async (_input, options) => {
        const signal = options?.signal;
        const body = new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
          },
        });
        return new Response(body, { status });
      };
      const controller = new AbortController();
      const result = fetchSession(controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      await assert.rejects(result, { name: "AbortError" });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
