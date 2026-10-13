import { z } from "zod";

export const MAXIMUM_TITLE_LENGTH = 120;
export const MAXIMUM_DESTINATION_LENGTH = 4096;
export const MAXIMUM_CUSTOM_SLUG_LENGTH = 48;

export const linkStatusSchema = z.enum(["active", "revoked"]);

export const linkSchema = z.object({
  slug: z.string(),
  title: z.string(),
  destination: z.string(),
  status: linkStatusSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Link = z.infer<typeof linkSchema>;
export type LinkStatus = z.infer<typeof linkStatusSchema>;

export const createLinkSchema = z.object({
  destination: z.string().trim().min(1).max(MAXIMUM_DESTINATION_LENGTH),
  title: z.string().trim().max(MAXIMUM_TITLE_LENGTH).default(""),
  slug: z.string().trim().max(MAXIMUM_CUSTOM_SLUG_LENGTH).optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict();

export const updateLinkSchema = z.object({
  destination: z.string().trim().min(1).max(MAXIMUM_DESTINATION_LENGTH).optional(),
  title: z.string().trim().max(MAXIMUM_TITLE_LENGTH).optional(),
  status: linkStatusSchema.optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Provide a change to apply.");

export type CreateLink = z.infer<typeof createLinkSchema>;
export type UpdateLink = z.infer<typeof updateLinkSchema>;

export const linkPageSchema = z.object({
  links: z.array(linkSchema),
  nextCursor: z.string().nullable(),
});

export type LinkPage = z.infer<typeof linkPageSchema>;

export const sessionSchema = z.object({
  email: z.string(),
  shortOrigin: z.string(),
  previewOrigin: z.string().nullable(),
  adminOrigin: z.string(),
});

export type Session = z.infer<typeof sessionSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
