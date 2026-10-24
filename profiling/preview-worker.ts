import { renderPreviewImage } from "../src/preview-image";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/empty") return new Response("ok");
    if (url.pathname === "/memory") {
      const diagnostics = globalThis as typeof globalThis & { __previewWasmBytes?: () => number };
      return Response.json({ wasmBytes: diagnostics.__previewWasmBytes?.() ?? null });
    }
    return renderPreviewImage({
      slug: "profile", title: url.searchParams.get("title") ?? "Design notes & useful links",
      destination: "https://example.com/notes", status: "active", expiresAt: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    }, "https://links.example.com");
  },
};
