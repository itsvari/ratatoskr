import type { LinkRecord } from "./types";

// Excludes visually ambiguous characters (0, O, I, l, 1) so that slugs
// are unambiguous when read aloud or transcribed by hand.
const SLUG_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";

const DEFAULT_SLUG_LENGTH = 6;

// Namespacing KV keys avoids collisions if the namespace is ever shared.
const LINK_KEY_PREFIX = "link:";

export function generateSlug(length: number = DEFAULT_SLUG_LENGTH): string {
    const randomBytes = new Uint8Array(length);
    crypto.getRandomValues(randomBytes);

    return Array.from(randomBytes)
        .map((randomByte) => SLUG_ALPHABET[randomByte % SLUG_ALPHABET.length] as string)
        .join("");
}

export function isValidSlug(slug: string): boolean {
    return slug.length > 0 && /^[A-Za-z0-9-]+$/.test(slug);
}

export async function getLink(
    kv: KVNamespace,
    slug: string,
): Promise<LinkRecord | null> {
    const serialised = await kv.get(LINK_KEY_PREFIX + slug);
    if (serialised === null) return null;
    return JSON.parse(serialised) as LinkRecord;
}

export async function putLink(
    kv: KVNamespace,
    record: LinkRecord,
): Promise<void> {
    await kv.put(LINK_KEY_PREFIX + record.slug, JSON.stringify(record));
}

export async function deleteLink(
    kv: KVNamespace,
    slug: string,
): Promise<void> {
    await kv.delete(LINK_KEY_PREFIX + slug);
}

/**
 * Lists all stored link records.
 *
 * KV `list()` is eventually consistent, so a key present in the listing
 * may have been deleted by the time we fetch it — those gaps are filtered out.
 */
export async function listLinks(kv: KVNamespace): Promise<LinkRecord[]> {
    const listing = await kv.list({ prefix: LINK_KEY_PREFIX });

    const records = await Promise.all(
        listing.keys.map(async ({ name }) => {
            const serialised = await kv.get(name);
            if (serialised === null) return null;
            return JSON.parse(serialised) as LinkRecord;
        }),
    );

    return records.filter((record): record is LinkRecord => record !== null);
}
