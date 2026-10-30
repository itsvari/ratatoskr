import { z } from "zod";

export const PREVIEW_IMAGE_WIDTH = 600;
export const PREVIEW_IMAGE_HEIGHT = 315;
export const PREVIEW_HEADER_HEIGHT = 72;
export const PREVIEW_SCANLINE_BYTES = PREVIEW_IMAGE_WIDTH * 4 + 1;
export const MAXIMUM_PREVIEW_UPLOAD_BYTES = 128 * 1024;

export const previewSegmentSchema = z.object({
  compressed: z.string().min(8).max(96 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  checksum: z.number().int().min(0).max(0xffffffff),
}).strict();
export type PreviewSegment = z.infer<typeof previewSegmentSchema>;
export const previewUploadSchema = z.object({
  title: z.string(), destination: z.string(), origin: z.url(), segment: previewSegmentSchema,
}).strict();
export type PreviewUpload = z.infer<typeof previewUploadSchema>;
