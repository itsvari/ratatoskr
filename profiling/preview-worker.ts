import { renderPreviewSvg } from "../src/preview-template";
import { createPreviewRenderer } from "../src/preview-renderer";
import { encodePng } from "../src/png";
import { MAXIMUM_DISPLAY_NAME_LENGTH, MAXIMUM_TITLE_LENGTH } from "../shared/contracts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/empty") return new Response("ok");
    if (url.pathname === "/memory") {
      const diagnostics = globalThis as typeof globalThis & { __previewWasmBytes?: () => number };
      return Response.json({ wasmBytes: diagnostics.__previewWasmBytes?.() ?? null });
    }
    const title = url.searchParams.get("title") ?? "Design notes & useful links";
    const displayName = url.searchParams.get("name") ?? "Ratatoskr";
    // the diagnostic endpoint is unauthenticated, so it enforces the application's own text bounds.
    if (title.length > MAXIMUM_TITLE_LENGTH || displayName.length > MAXIMUM_DISPLAY_NAME_LENGTH) {
      return new Response("Title or name is too long.", { status: 400 });
    }
    const svg = renderPreviewSvg({
      slug: "profile", title,
      destination: "https://example.com/notes", status: "active", expiresAt: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    }, "https://links.example.com", displayName);
    const renderer = await createPreviewRenderer(svg);
    try {
      const image = renderer.render();
      try { return new Response(encodePng(image.pixels, image.width, image.height)); }
      finally { image.free(); }
    } finally { renderer.free(); }
  },
};
