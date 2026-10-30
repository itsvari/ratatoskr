import type { Link } from "../shared/contracts";
import { compressPreviewSection } from "../shared/preview-compression";
import { PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT } from "../shared/preview-image";
import { createPreviewRenderer } from "../src/preview-renderer";
import { renderPreviewSvg } from "../src/preview-template";

export async function previewSections(name: string, link: Link = { slug: "fixture", title: "Notes",
  destination: "http://192.0.2.1/notes", status: "active", expiresAt: null, createdAt: "", updatedAt: "" }) {
  const renderer = await createPreviewRenderer(renderPreviewSvg(link, "http://localhost:5173", name));
  try {
    const image = renderer.render();
    try {
      return { header: compressPreviewSection(image.pixels, 0, PREVIEW_HEADER_HEIGHT),
        body: compressPreviewSection(image.pixels, PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT) };
    } finally { image.free(); }
  } finally { renderer.free(); }
}
