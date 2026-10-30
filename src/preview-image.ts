import { z } from "zod";
import { storedPreviewSegmentSchema, type PreviewUpload } from "../shared/preview-image";
import { assemblePreviewPng } from "./png";
import { ApplicationError } from "./errors";
import { renderUnavailable } from "./preview";
import defaultHeader from "./assets/preview-header.json";

const storedImageSchema = z.object({
  status: z.enum(["active", "revoked"]), expiresAt: z.string().nullable(),
  segment: z.string().nullable(), header: z.string().nullable(),
});

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

export async function renderPreviewImage(database: D1Database, slug: string, shortOrigin: string,
  options: { readonly head?: boolean } = {}): Promise<Response> {
  const row = await database.withSession("first-primary").prepare(`
    SELECT link.status, link.expires_at AS expiresAt, image.segment, branding.segment AS header
    FROM links link LEFT JOIN preview_images image
      ON link.slug = image.slug AND link.title = image.title AND link.destination = image.destination AND image.origin = ?
    LEFT JOIN preview_branding branding ON branding.singleton = 1
    WHERE link.slug = ? AND link.status != 'deleted'`)
    .bind(shortOrigin, slug).first();
  if (row === null) return renderUnavailable(404);
  const stored = storedImageSchema.parse(row);
  if (stored.status !== "active" || (stored.expiresAt !== null && Date.parse(stored.expiresAt) <= Date.now())) {
    return renderUnavailable(410);
  }
  if (stored.segment === null) {
    return new Response("Preview image is not ready. Save the link in the admin panel to generate it.", {
      status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" },
    });
  }
  if (options.head) return new Response(null, { headers: { "Content-Type": "image/png", "X-Robots-Tag": "noindex", "Cache-Control": "no-store" } });
  const body = storedPreviewSegmentSchema.parse(JSON.parse(stored.segment));
  const header = stored.header === null ? defaultHeader : storedPreviewSegmentSchema.parse(JSON.parse(stored.header));
  return new Response(assemblePreviewPng(header, body), {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
