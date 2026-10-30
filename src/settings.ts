import { DEFAULT_DISPLAY_NAME, siteSettingsSchema, updateSiteSettingsSchema, type UpdateSiteSettings, type SiteSettings } from "../shared/contracts";
import type { Administrator } from "./auth";

export async function getSiteSettings(database: D1Database): Promise<SiteSettings> {
  const row = await database.withSession("first-primary")
    .prepare("SELECT display_name AS displayName FROM site_settings WHERE singleton = 1").first();
  return siteSettingsSchema.parse(row);
}

export async function updateSiteSettings(database: D1Database, administrator: Administrator, settings: UpdateSiteSettings): Promise<SiteSettings> {
  const { displayName, previewHeader } = updateSiteSettingsSchema.parse(settings);
  const header = displayName === DEFAULT_DISPLAY_NAME ? null : JSON.stringify(previewHeader);
  const session = database.withSession("first-primary");
  const results = await session.batch([
    session.prepare("INSERT INTO administrators (subject, email) VALUES (?, ?) ON CONFLICT(subject) DO UPDATE SET email = excluded.email")
      .bind(administrator.subject, administrator.email),
    session.prepare("UPDATE site_settings SET display_name = ? WHERE singleton = 1 AND (display_name != ? OR (SELECT segment FROM preview_branding WHERE singleton = 1) IS NOT ?) RETURNING display_name AS displayName")
      .bind(displayName, displayName, header),
    session.prepare("INSERT INTO site_settings_audit (identifier, actor_subject, display_name, created_at) SELECT ?, ?, ?, ? WHERE changes() > 0")
      .bind(crypto.randomUUID(), administrator.subject, displayName, new Date().toISOString()),
    session.prepare("UPDATE preview_branding SET segment = ? WHERE singleton = 1 AND changes() > 0").bind(header),
  ]);
  const updated = results[1]?.results[0];
  return updated === undefined ? getSiteSettings(database) : siteSettingsSchema.parse(updated);
}
