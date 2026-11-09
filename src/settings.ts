import { DEFAULT_DISPLAY_NAME, siteSettingsSchema, updateSiteSettingsSchema, type UpdateSiteSettings, type SiteSettings } from "../shared/contracts";
import type { Administrator } from "./auth";
import { validatePreviewSegment } from "./preview-segment";

export async function getSiteSettings(database: D1Database): Promise<SiteSettings> {
  const row = await database.withSession("first-primary")
    .prepare("SELECT display_name AS displayName, home_redirect_url AS homeRedirectUrl FROM site_settings WHERE singleton = 1").first();
  return siteSettingsSchema.parse(row);
}

export async function updateSiteSettings(database: D1Database, administrator: Administrator, settings: UpdateSiteSettings): Promise<SiteSettings> {
  const { displayName, homeRedirectUrl, previewHeader } = updateSiteSettingsSchema.parse(settings);
  const nameProvided = displayName !== undefined;
  const urlProvided = homeRedirectUrl !== undefined;
  const header = !nameProvided || displayName === DEFAULT_DISPLAY_NAME || previewHeader === undefined ? null
    : JSON.stringify(validatePreviewSegment(previewHeader, "header"));
  const session = database.withSession("first-primary");
  // these three statements must remain adjacent because changes() gates the audit and branding.
  const results = await session.batch([
    session.prepare("INSERT INTO administrators (subject, email) VALUES (?, ?) ON CONFLICT(subject) DO UPDATE SET email = excluded.email")
      .bind(administrator.subject, administrator.email),
    session.prepare("UPDATE site_settings SET display_name = CASE WHEN ? THEN ? ELSE display_name END, home_redirect_url = CASE WHEN ? THEN ? ELSE home_redirect_url END WHERE singleton = 1 AND ((? AND (display_name != ? OR (SELECT segment FROM preview_branding WHERE singleton = 1) IS NOT ?)) OR (? AND home_redirect_url IS NOT ?)) RETURNING display_name AS displayName, home_redirect_url AS homeRedirectUrl")
      .bind(nameProvided, displayName ?? null, urlProvided, homeRedirectUrl ?? null, nameProvided, displayName ?? null, header, urlProvided, homeRedirectUrl ?? null),
    session.prepare("INSERT INTO site_settings_audit (identifier, actor_subject, display_name, home_redirect_url, created_at) SELECT ?, ?, display_name, home_redirect_url, ? FROM site_settings WHERE singleton = 1 AND changes() > 0")
      .bind(crypto.randomUUID(), administrator.subject, new Date().toISOString()),
    session.prepare("UPDATE preview_branding SET segment = ? WHERE singleton = 1 AND ? AND changes() > 0").bind(header, nameProvided),
  ]);
  const updated = results[1]?.results[0];
  return updated === undefined ? getSiteSettings(database) : siteSettingsSchema.parse(updated);
}
