import { z } from "zod";
import { previewSegmentSchema } from "./preview-image";

export const MAXIMUM_TITLE_LENGTH = 120;
export const MAXIMUM_DESTINATION_LENGTH = 4096;
export const MAXIMUM_CUSTOM_SLUG_LENGTH = 48;
export const DEFAULT_DISPLAY_NAME = "Ratatoskr";
export const MAXIMUM_DISPLAY_NAME_LENGTH = 48;

const homeRedirectUrlSchema = z.string().trim().min(1).max(MAXIMUM_DESTINATION_LENGTH)
  .refine((value) => {
    try {
      const target = new URL(value);
      return ["http:", "https:"].includes(target.protocol) && !target.username && !target.password;
    } catch {
      return false;
    }
  }, "Enter an absolute HTTP or HTTPS address without credentials.");

export const siteSettingsSchema = z.object({
  displayName: z.string().trim().min(1, "Enter a display name.").max(MAXIMUM_DISPLAY_NAME_LENGTH)
    .regex(/^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}\uFFFE\uFFFF]+$/u, "Use a single line without control or invalid Unicode characters."),
  // null shows the built-in home page instead of redirecting
  homeRedirectUrl: homeRedirectUrlSchema.nullable(),
}).strict();

export const siteSettingsPatchSchema = siteSettingsSchema.partial()
  .refine((settings) => Object.keys(settings).length > 0, "Provide a change to apply.");
export type SiteSettingsPatch = z.infer<typeof siteSettingsPatchSchema>;

export const updateSiteSettingsSchema = siteSettingsSchema.partial().extend({ previewHeader: previewSegmentSchema.optional() })
  .refine((settings) => settings.displayName !== undefined || settings.homeRedirectUrl !== undefined, "Provide a change to apply.")
  .refine((settings) => settings.previewHeader === undefined || settings.displayName !== undefined, "Provide a display name with preview branding.")
  .refine((settings) => settings.displayName === undefined || settings.displayName === DEFAULT_DISPLAY_NAME || settings.previewHeader !== undefined,
    "Generate the preview branding before saving the display name.");
export type UpdateSiteSettings = z.infer<typeof updateSiteSettingsSchema>;
export type SiteSettings = z.infer<typeof siteSettingsSchema>;

export function linkExportFilename(displayName: string, date?: string): string {
  const prefix = displayName.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${prefix ? `${prefix}-` : ""}links${date ? `-${date}` : ""}.json`;
}

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
  requestId: z.uuid().optional(),
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
  displayName: siteSettingsSchema.shape.displayName,
  homeRedirectUrl: siteSettingsSchema.shape.homeRedirectUrl,
});

export type Session = z.infer<typeof sessionSchema>;

export const apiErrorSchema = z.object({ error: z.string() });
