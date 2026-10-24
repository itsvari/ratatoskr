import { siteSettingsSchema, type SiteSettings } from "../shared/contracts";
import type { Administrator } from "./auth";

export async function getSiteSettings(database: D1Database): Promise<SiteSettings> {
  const row = await database.withSession("first-primary")
    .prepare("SELECT display_name AS displayName FROM site_settings WHERE singleton = 1").first();
  return siteSettingsSchema.parse(row);
}

export async function updateSiteSettings(database: D1Database, administrator: Administrator, settings: SiteSettings): Promise<SiteSettings> {
  const { displayName } = siteSettingsSchema.parse(settings);
  const session = database.withSession("first-primary");
  const results = await session.batch([
    session.prepare("INSERT INTO administrators (subject, email) VALUES (?, ?) ON CONFLICT(subject) DO UPDATE SET email = excluded.email")
      .bind(administrator.subject, administrator.email),
    session.prepare("UPDATE site_settings SET display_name = ? WHERE singleton = 1 AND display_name != ? RETURNING display_name AS displayName")
      .bind(displayName, displayName),
    session.prepare("INSERT INTO site_settings_audit (identifier, actor_subject, display_name, created_at) SELECT ?, ?, ?, ? WHERE changes() > 0")
      .bind(crypto.randomUUID(), administrator.subject, displayName, new Date().toISOString()),
  ]);
  const updated = results[1]?.results[0];
  return updated === undefined ? getSiteSettings(database) : siteSettingsSchema.parse(updated);
}
