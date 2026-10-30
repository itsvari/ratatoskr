import { z } from "zod";
import type { Link } from "../shared/contracts";
import { previewSegmentSchema, type PreviewUpload, type PreviewSegment } from "../shared/preview-image";
import { assemblePreviewPng } from "./png";
import { ApplicationError } from "./errors";
import defaultHeader from "./assets/preview-header.json";
export { renderPreviewSvg } from "./preview-template";

export async function storePreviewImage(database: D1Database, slug: string, upload: PreviewUpload): Promise<void> {
  const result = await database.withSession("first-primary").prepare(`
    INSERT INTO preview_images (slug, title, destination, origin, segment)
    SELECT slug, title, destination, ?, ? FROM links
    WHERE slug = ? AND status != 'deleted' AND title = ? AND destination = ?
    ON CONFLICT(slug) DO UPDATE SET title = excluded.title, destination = excluded.destination,
      origin = excluded.origin, segment = excluded.segment RETURNING slug`)
    .bind(upload.origin, JSON.stringify(upload.segment), slug, upload.title, upload.destination).first();
  if (result === null) throw new ApplicationError("The link changed. Reload it before generating its image again.", 409);
}

export async function renderPreviewImage(database: D1Database, link: Link, shortOrigin: string,
  options: { readonly header?: PreviewSegment | null; readonly head?: boolean } = {}): Promise<Response> {
  const header = options.header === undefined ? defaultHeader : options.header;
  const row = await database.withSession("first-primary").prepare(`
    SELECT image.segment FROM preview_images image JOIN links link ON link.slug = image.slug
    WHERE link.slug = ? AND link.status = 'active' AND (link.expires_at IS NULL OR julianday(link.expires_at) > julianday('now'))
      AND link.title = image.title AND link.destination = image.destination
      AND image.title = ? AND image.destination = ? AND image.origin = ?`)
    .bind(link.slug, link.title, link.destination, shortOrigin).first();
  if (row === null || header === null) {
    return new Response("Preview image is not ready. Save the link in the admin panel to generate it.", {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }
  if (options.head) return new Response(null, { headers: { "Content-Type": "image/png", "X-Robots-Tag": "noindex", "Cache-Control": "no-store" } });
  const { segment } = z.object({ segment: z.string() }).parse(row);
  const body = previewSegmentSchema.parse(JSON.parse(segment));
  return new Response(assemblePreviewPng(header, body), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
