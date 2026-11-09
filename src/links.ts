import { z } from "zod";
import { linkSchema, MAXIMUM_CUSTOM_SLUG_LENGTH, type CreateLink, type Link, type LinkPage, type LinkStatus, type UpdateLink } from "../shared/contracts";
import type { Administrator } from "./auth";
import type { Configuration } from "./configuration";
import { ApplicationError } from "./errors";
import { generateSlug, INITIAL_SYLLABLE_COUNT, parseCustomSlug } from "./slugs";

const PAGE_SIZE = 50;
const MAXIMUM_SEARCH_LENGTH = 120;
const MAXIMUM_CURSOR_LENGTH = 512;
const COLLISION_ATTEMPTS_PER_LENGTH = 8;
const MAXIMUM_ALLOCATION_ATTEMPTS = 14;
const CHARACTERS_PER_SYLLABLE = 2;
const MAXIMUM_SYLLABLE_COUNT = MAXIMUM_CUSTOM_SLUG_LENGTH / CHARACTERS_PER_SYLLABLE;
const LINK_COLUMNS = "slug, title, destination, status, expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt";
const databaseLinkSchema = linkSchema.strict();
const cursorSchema = z.object({ createdAt: z.iso.datetime(), slug: z.string().min(1).max(MAXIMUM_CUSTOM_SLUG_LENGTH) }).strict();
const syllableSettingSchema = z.object({ value: z.number().int().min(INITIAL_SYLLABLE_COUNT).max(MAXIMUM_SYLLABLE_COUNT) }).strict();

function administratorStatement(database: D1DatabaseSession, administrator: Administrator): D1PreparedStatement {
  return database.prepare("INSERT INTO administrators (subject, email) VALUES (?, ?) ON CONFLICT(subject) DO UPDATE SET email = excluded.email")
    .bind(administrator.subject, administrator.email);
}

function auditStatement(database: D1DatabaseSession, administrator: Administrator, slug: string, action: string, createdAt: string): D1PreparedStatement {
  // changes() refers to the immediately preceding mutation inside the same transaction.
  return database.prepare("INSERT INTO audit_events (identifier, actor_subject, action, slug, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() > 0")
    .bind(crypto.randomUUID(), administrator.subject, action, slug, createdAt);
}

function canonicalDestination(destination: string): string {
  let target: URL;
  try {
    target = new URL(destination);
  } catch {
    throw new ApplicationError("Enter an absolute HTTP or HTTPS destination.", 400);
  }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new ApplicationError("Destinations must use HTTP or HTTPS without credentials.", 400);
  }
  return target.href;
}

export function validateDestination(destination: string, configuration: Configuration): string {
  const canonical = canonicalDestination(destination);
  const destinationHostname = new URL(canonical).hostname.replace(/\.$/, "");
  const shortenerOrigins = [configuration.shortOrigin, configuration.adminOrigin, configuration.previewOrigin];
  if (shortenerOrigins.some((origin) => origin !== null && new URL(origin).hostname.replace(/\.$/, "") === destinationHostname)) {
    throw new ApplicationError("Destinations cannot point back to this shortener.", 400);
  }
  return canonical;
}

function validateExpiry(expiresAt: string | null | undefined): string | null {
  if (expiresAt == null) {
    return null;
  }
  const timestampMs = Date.parse(expiresAt);
  if (!Number.isFinite(timestampMs) || timestampMs <= Date.now()) {
    throw new ApplicationError("Expiry must be a future date.", 400);
  }
  return new Date(timestampMs).toISOString();
}

export async function getLink(database: D1Database, slug: string): Promise<Link | null> {
  const row = await database.withSession("first-primary").prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE slug = ? AND status != 'deleted'`).bind(slug).first();
  return row === null ? null : databaseLinkSchema.parse(row);
}

const receiptSchema = z.object({ requestHash: z.string().nullable(), slug: z.string(), title: z.string(), destination: z.string().nullable(),
  status: z.enum(["active", "revoked", "deleted"]), expiresAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() }).strict();
const RECEIPT_SELECT = `SELECT request_hash AS requestHash, ${LINK_COLUMNS} FROM creation_requests JOIN links USING (slug) WHERE actor_subject = ? AND request_id = ?`;

function classifyReceipt(row: unknown, requestHash: string): Link | null {
  if (row === null || row === undefined) return null;
  const receipt = receiptSchema.parse(row);
  if (receipt.status === "deleted") throw new ApplicationError("This creation was completed and then deleted.", 409);
  if (receipt.requestHash !== requestHash) throw new ApplicationError("This request identifier was already used for a different creation.", 409);
  const { requestHash: _requestHash, ...link } = receipt;
  return databaseLinkSchema.parse(link);
}

async function insertLink(database: D1Database, administrator: Administrator, slug: string, draft: CreateLink, requestHash: string | null): Promise<Link | null> {
  const session = database.withSession("first-primary");
  const createdAt = new Date().toISOString();
  if (draft.requestId === undefined || requestHash === null) {
    const results = await session.batch([
      administratorStatement(session, administrator),
      session.prepare(`INSERT INTO links (slug, title, destination, status, expires_at, created_at, updated_at, created_by) VALUES (?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING RETURNING ${LINK_COLUMNS}`)
        .bind(slug, draft.title, draft.destination, draft.expiresAt ?? null, createdAt, createdAt, administrator.subject),
      auditStatement(session, administrator, slug, "create", createdAt),
    ]);
    const row = results[1]?.results[0];
    return row === undefined ? null : databaseLinkSchema.parse(row);
  }
  const results = await session.batch([
    administratorStatement(session, administrator),
    session.prepare("INSERT INTO links (slug, title, destination, status, expires_at, created_at, updated_at, created_by) SELECT ?, ?, ?, 'active', ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM creation_requests WHERE actor_subject = ? AND request_id = ?) ON CONFLICT(slug) DO NOTHING")
      .bind(slug, draft.title, draft.destination, draft.expiresAt ?? null, createdAt, createdAt, administrator.subject, administrator.subject, draft.requestId),
    auditStatement(session, administrator, slug, "create", createdAt),
    session.prepare("INSERT INTO creation_requests (actor_subject, request_id, request_hash, slug) SELECT ?, ?, ?, ? WHERE changes() > 0")
      .bind(administrator.subject, draft.requestId, requestHash, slug),
    session.prepare(RECEIPT_SELECT).bind(administrator.subject, draft.requestId),
  ]);
  return classifyReceipt(results[4]?.results[0], requestHash);
}

export async function createLink(input: { database: D1Database; configuration: Configuration; administrator: Administrator; draft: CreateLink }): Promise<Link> {
  const { database, configuration, administrator, draft } = input;
  const destination = canonicalDestination(draft.destination);
  const slug = draft.slug?.trim() ? parseCustomSlug(draft.slug) : null;
  if (draft.slug?.trim() && slug === null) {
    throw new ApplicationError("Use a non-reserved slug of lowercase letters, digits and internal hyphens, up to 48 characters.", 400);
  }
  const expiresAt = draft.expiresAt == null ? null : new Date(draft.expiresAt).toISOString();
  const bytes = new TextEncoder().encode(JSON.stringify([destination, draft.title.trim(), slug, expiresAt]));
  const requestHash = draft.requestId === undefined ? null : Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (draft.requestId !== undefined && requestHash !== null) {
    const row = await database.withSession("first-primary").prepare(RECEIPT_SELECT).bind(administrator.subject, draft.requestId).first();
    const replay = classifyReceipt(row, requestHash);
    if (replay !== null) return replay;
  }
  const validatedDraft = { ...draft, title: draft.title.trim(), destination: validateDestination(destination, configuration), expiresAt: validateExpiry(expiresAt) };
  if (slug !== null) {
    const created = await insertLink(database, administrator, slug, validatedDraft, requestHash);
    if (created === null) throw new ApplicationError("That shortlink is already reserved.", 409);
    return created;
  }
  const session = database.withSession("first-primary");
  const setting = syllableSettingSchema.parse(await session.prepare("SELECT value FROM settings WHERE name = 'generated_syllables'").first());
  let allocationAttempts = 0;
  for (let syllableCount = setting.value; syllableCount <= MAXIMUM_SYLLABLE_COUNT; syllableCount += 1) {
    for (let attemptCount = 0; attemptCount < COLLISION_ATTEMPTS_PER_LENGTH && allocationAttempts < MAXIMUM_ALLOCATION_ATTEMPTS; attemptCount += 1) {
      allocationAttempts += 1;
      const created = await insertLink(database, administrator, generateSlug(syllableCount), validatedDraft, requestHash);
      if (created !== null) return created;
    }
    if (allocationAttempts >= MAXIMUM_ALLOCATION_ATTEMPTS) break;
    if (syllableCount < MAXIMUM_SYLLABLE_COUNT) {
      // max keeps growth monotonic when concurrent allocations exhaust the same length.
      await session.prepare("UPDATE settings SET value = MAX(value, ?) WHERE name = 'generated_syllables'").bind(syllableCount + 1).run();
    }
  }
  throw new ApplicationError("Unable to allocate a shortlink. Try again later.", 503);
}

export async function updateLink(input: { database: D1Database; configuration: Configuration; administrator: Administrator; slug: string; patch: UpdateLink }): Promise<Link> {
  const { database, configuration, administrator, slug, patch } = input;
  const destination = patch.destination === undefined ? null : validateDestination(patch.destination, configuration);
  const expiryProvided = patch.expiresAt !== undefined;
  const expiresAt = validateExpiry(patch.expiresAt);
  const updatedAt = new Date().toISOString();
  const session = database.withSession("first-primary");
  const results = await session.batch([
    administratorStatement(session, administrator),
    session.prepare(`INSERT INTO audit_events (identifier, actor_subject, action, slug, created_at) SELECT ?, ?, CASE WHEN ? IS NOT NULL AND status != ? THEN CASE WHEN ? = 'revoked' THEN 'revoke' ELSE 'restore' END ELSE 'update' END, slug, ? FROM links WHERE slug = ? AND status != 'deleted' AND NOT (destination IS COALESCE(?, destination) AND title IS COALESCE(?, title) AND status IS COALESCE(?, status) AND expires_at IS CASE WHEN ? THEN ? ELSE expires_at END)`)
      .bind(crypto.randomUUID(), administrator.subject, patch.status ?? null, patch.status ?? null, patch.status ?? null, updatedAt, slug, destination, patch.title ?? null, patch.status ?? null, expiryProvided, expiresAt),
    session.prepare(`UPDATE links SET destination = COALESCE(?, destination), title = COALESCE(?, title), status = COALESCE(?, status), expires_at = CASE WHEN ? THEN ? ELSE expires_at END, updated_at = ? WHERE slug = ? AND changes() > 0 RETURNING ${LINK_COLUMNS}`)
      .bind(destination, patch.title ?? null, patch.status ?? null, expiryProvided, expiresAt, updatedAt, slug),
  ]);
  const row = results[2]?.results[0];
  if (row !== undefined) {
    return databaseLinkSchema.parse(row);
  }
  const existing = await getLink(database, slug);
  if (existing === null) {
    throw new ApplicationError("Shortlink not found.", 404);
  }
  return existing;
}

export async function deleteLink(database: D1Database, slug: string, administrator: Administrator): Promise<void> {
  const session = database.withSession("first-primary");
  const updatedAt = new Date().toISOString();
  const results = await session.batch([
    administratorStatement(session, administrator),
    session.prepare("UPDATE links SET destination = NULL, title = '', status = 'deleted', expires_at = NULL, updated_at = ? WHERE slug = ? AND status != 'deleted' RETURNING slug").bind(updatedAt, slug),
    auditStatement(session, administrator, slug, "delete", updatedAt),
  ]);
  if (results[1]?.results.length === 0) {
    const existing = await session.prepare("SELECT slug FROM links WHERE slug = ?").bind(slug).first();
    if (existing === null) throw new ApplicationError("Shortlink not found.", 404);
  }
}

function parseCursor(cursor: string | undefined): z.infer<typeof cursorSchema> | null {
  if (!cursor) {
    return null;
  }
  try {
    if (cursor.length > MAXIMUM_CURSOR_LENGTH) {
      throw new Error("Cursor too long");
    }
    return cursorSchema.parse(JSON.parse(atob(cursor)));
  } catch {
    throw new ApplicationError("Invalid pagination cursor.", 400);
  }
}

export async function listLinks(database: D1Database, input: { search: string; status?: LinkStatus; cursor?: string }): Promise<LinkPage> {
  if (input.search.length > MAXIMUM_SEARCH_LENGTH) {
    throw new ApplicationError("Search must be at most 120 characters.", 400);
  }
  const cursor = parseCursor(input.cursor);
  const escapedSearch = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`;
  const results = await database.withSession("first-primary").prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE status != 'deleted' AND (? IS NULL OR status = ?) AND (slug LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR destination LIKE ? ESCAPE '\\') AND (? IS NULL OR created_at < ? OR (created_at = ? AND slug < ?)) ORDER BY created_at DESC, slug DESC LIMIT ?`)
    .bind(input.status ?? null, input.status ?? null, escapedSearch, escapedSearch, escapedSearch, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.slug ?? null, PAGE_SIZE + 1).all();
  const links = z.array(databaseLinkSchema).parse(results.results);
  const page = links.slice(0, PAGE_SIZE);
  const lastLink = page.at(-1);
  return { links: page, nextCursor: links.length > PAGE_SIZE && lastLink ? btoa(JSON.stringify({ createdAt: lastLink.createdAt, slug: lastLink.slug })) : null };
}

export async function exportLinks(database: D1Database): Promise<readonly Link[]> {
  const results = await database.withSession("first-primary").prepare(`SELECT ${LINK_COLUMNS} FROM links WHERE status != 'deleted' ORDER BY created_at DESC, slug DESC`).all();
  return z.array(databaseLinkSchema).parse(results.results);
}
