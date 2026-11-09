import { env, SELF } from "cloudflare:test";
import { linkSchema } from "../shared/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Configuration } from "../src/configuration";
import { createLink, deleteLink, exportLinks, getLink, listLinks, updateLink } from "../src/links";

const configuration: Configuration = {
  shortOrigin: "https://v4ri.link",
  adminOrigin: "https://admin.v4ri.link",
  previewOrigin: "https://preview.v4ri.link",
  accessIssuer: "https://test.cloudflareaccess.com",
  accessAudience: "audience",
  administratorEmails: ["owner@example.com"],
  localDevelopment: false,
};
const administrator = { subject: "owner", email: "owner@example.com" };
const draft = { title: "Example", destination: "https://example.com/path" };

function create(slug?: string) {
  return createLink({ database: env.DB, configuration, administrator, draft: { ...draft, ...(slug === undefined ? {} : { slug }) } });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_events"),
    env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM administrators"),
    env.DB.prepare("UPDATE settings SET value = 3 WHERE name = 'generated_syllables'"),
  ]);
});

afterEach(() => vi.restoreAllMocks());

describe("authoritative D1 link storage", () => {
  it("replays concurrent keyed creations and clears the receipt hash on deletion", async () => {
    const requestId = crypto.randomUUID();
    const request = () => createLink({ database: env.DB, configuration, administrator, draft: { ...draft, requestId } });
    const links = await Promise.all(Array.from({ length: 6 }, request));
    expect(new Set(links.map((link) => link.slug)).size).toBe(1);
    expect(await request()).toEqual(links[0]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM links").first("count")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM creation_requests").first("count")).toBe(1);
    await expect(createLink({ database: env.DB, configuration, administrator, draft: { ...draft, title: "Different", requestId } })).rejects.toMatchObject({ status: 409 });
    const slug = links[0]?.slug;
    if (!slug) throw new Error("Missing created slug");
    await deleteLink(env.DB, slug, administrator);
    expect(await env.DB.prepare("SELECT request_hash FROM creation_requests WHERE slug = ?").bind(slug).first("request_hash")).toBeNull();
    await expect(request()).rejects.toMatchObject({ status: 409 });
  });

  it("replays expired creations and scopes keys to each administrator", async () => {
    const requestId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const keyedDraft = { ...draft, requestId, expiresAt };
    const first = await createLink({ database: env.DB, configuration, administrator, draft: keyedDraft });
    const other = await createLink({ database: env.DB, configuration, administrator: { subject: "other", email: "other@example.com" }, draft: keyedDraft });
    expect(first.slug).not.toBe(other.slug);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expiresAt) + 1);
    expect(await createLink({ database: env.DB, configuration, administrator, draft: keyedDraft })).toEqual(first);
    await expect(createLink({ database: env.DB, configuration, administrator, draft: { ...keyedDraft, requestId: crypto.randomUUID() } })).rejects.toMatchObject({ status: 400 });
  });

  it("retries generated collisions and leaves no receipt for a custom collision", async () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((values) => {
      if (!(values instanceof Uint8Array)) throw new TypeError("Expected syllable bytes.");
      values.fill(0);
      return values;
    });
    await create("mamama");
    const generated = await createLink({ database: env.DB, configuration, administrator, draft: { ...draft, requestId: crypto.randomUUID() } });
    expect(generated.slug).toBe("mamamama");
    const requestId = crypto.randomUUID();
    await expect(createLink({ database: env.DB, configuration, administrator, draft: { ...draft, slug: "mamama", requestId } })).rejects.toMatchObject({ status: 409 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM creation_requests WHERE request_id = ?").bind(requestId).first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM links").first("count")).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM creation_requests").first("count")).toBe(1);
  });

  it("returns HTTP 201 with the current link when a creation is replayed", async () => {
    const origin = "http://localhost:5173";
    const requestId = crypto.randomUUID();
    const submit = () => SELF.fetch(`${origin}/api/links`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, requestId }) });
    const first = await submit();
    expect(first.status).toBe(201);
    const created = linkSchema.parse(await first.json());
    const patch = await SELF.fetch(`${origin}/api/links/${created.slug}`, { method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ title: "Updated" }) });
    expect(patch.status).toBe(200);
    const replay = await submit();
    expect(replay.status).toBe(201);
    expect(linkSchema.parse(await replay.json())).toEqual(linkSchema.parse(await patch.json()));
  });

  it("allows simultaneous deletion retries with one delete audit", async () => {
    await create("launch");
    await Promise.all(Array.from({ length: 6 }, () => deleteLink(env.DB, "launch", administrator)));
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'delete'").first("count")).toBe(1);
  });

  it("rolls back keyed creation when the create audit fails", async () => {
    await env.DB.prepare("CREATE TRIGGER reject_keyed_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
    try {
      await expect(createLink({ database: env.DB, configuration, administrator, draft: { ...draft, requestId: crypto.randomUUID() } })).rejects.toThrow();
      for (const table of ["links", "audit_events", "creation_requests", "administrators"]) {
        expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count")).toBe(0);
      }
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_keyed_audit").run();
    }
  });

  it("rolls back a keyed creation when its receipt fails", async () => {
    await env.DB.prepare("CREATE TRIGGER reject_receipt BEFORE INSERT ON creation_requests BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END").run();
    try {
      await expect(createLink({ database: env.DB, configuration, administrator, draft: { ...draft, requestId: crypto.randomUUID() } })).rejects.toThrow();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM links").first("count")).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_receipt").run();
    }
  });

  it("audits mixed updates from the actual previous status and rolls back failed mutations", async () => {
    await create("launch");
    await updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { status: "active", title: "Changed" } });
    expect(await env.DB.prepare("SELECT action FROM audit_events WHERE action != 'create'").first("action")).toBe("update");
    await env.DB.prepare("CREATE TRIGGER reject_link_update BEFORE UPDATE ON links BEGIN SELECT RAISE(ABORT, 'update unavailable'); END").run();
    try {
      await expect(updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { title: "Rejected" } })).rejects.toThrow();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(2);
      expect((await getLink(env.DB, "launch"))?.title).toBe("Changed");
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_link_update").run();
    }
  });

  it("allocates exactly one custom slug under simultaneous creation and audits only the winner", async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => create("launch")));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ status: 409 });
      }
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(1);
    expect(await getLink(env.DB, "launch")).toMatchObject({ slug: "launch", status: "active" });
  });

  it("rolls back link and administrator creation when the audit write fails", async () => {
    await env.DB.prepare("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END").run();
    try {
      await expect(create("launch")).rejects.toThrow();
      expect(await getLink(env.DB, "launch")).toBeNull();
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM administrators").first("count")).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_audit").run();
    }
  });

  it("cannot resurrect a tombstone during concurrent deletion and editing", async () => {
    await create("launch");
    await Promise.allSettled([
      deleteLink(env.DB, "launch", administrator),
      updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { destination: "https://example.org/", status: "active" } }),
    ]);
    expect(await getLink(env.DB, "launch")).toBeNull();
    expect(await env.DB.prepare("SELECT destination, status FROM links WHERE slug = 'launch'").first())
      .toEqual({ destination: null, status: "deleted" });
  });

  it("reads revocations immediately and preserves independent concurrent field edits", async () => {
    await create("launch");
    await Promise.all([
      updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { title: "New title" } }),
      updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { destination: "https://example.org/" } }),
    ]);
    expect(await getLink(env.DB, "launch")).toMatchObject({ title: "New title", destination: "https://example.org/" });
    await updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { status: "revoked" } });
    expect(await getLink(env.DB, "launch")).toMatchObject({ status: "revoked" });
    await updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { status: "active" } });
    expect(await getLink(env.DB, "launch")).toMatchObject({ status: "active" });
  });

  it("erases deleted destinations, permanently reserves their slug and excludes tombstones from reads", async () => {
    await create("launch");
    await deleteLink(env.DB, "launch", administrator);
    expect(await getLink(env.DB, "launch")).toBeNull();
    expect(await exportLinks(env.DB)).toEqual([]);
    expect((await listLinks(env.DB, { search: "" })).links).toEqual([]);
    expect(await env.DB.prepare("SELECT destination, title, expires_at, status FROM links WHERE slug = 'launch'").first())
      .toEqual({ destination: null, title: "", expires_at: null, status: "deleted" });
    await expect(create("launch")).rejects.toMatchObject({ status: 409 });
    await expect(updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { status: "active" } })).rejects.toMatchObject({ status: 404 });
    await expect(deleteLink(env.DB, "launch", administrator)).resolves.toBeUndefined();
    await expect(deleteLink(env.DB, "missing", administrator)).rejects.toMatchObject({ status: 404 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(2);
  });

  it("does not audit unchanged updates", async () => {
    await create("launch");
    await updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { title: draft.title } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(1);
  });

  it("uses persisted growth and grows again after bounded collisions", async () => {
    await env.DB.prepare("UPDATE settings SET value = 4 WHERE name = 'generated_syllables'").run();
    const first = await create();
    expect(first.slug).toHaveLength(8);
    vi.spyOn(crypto, "getRandomValues").mockImplementation((values) => {
      if (!(values instanceof Uint8Array)) {
        throw new TypeError("Expected syllable bytes.");
      }
      values.fill(0);
      return values;
    });
    expect((await create()).slug).toBe("mamamama");
    expect((await create()).slug).toBe("mamamamama");
    expect(await env.DB.prepare("SELECT value FROM settings WHERE name = 'generated_syllables'").first("value")).toBe(5);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(3);
  });

  it("stops collision allocation at the configured resource bound", async () => {
    await env.DB.prepare("UPDATE settings SET value = 24 WHERE name = 'generated_syllables'").run();
    vi.spyOn(crypto, "getRandomValues").mockImplementation((values) => {
      if (!(values instanceof Uint8Array)) {
        throw new TypeError("Expected syllable bytes.");
      }
      values.fill(0);
      return values;
    });
    await create();
    await expect(create()).rejects.toMatchObject({ status: 503 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit_events").first("count")).toBe(1);
  });

  it.each(["javascript:alert(1)", "https://user:secret@example.com", "/relative", "https://v4ri.link/launch", "http://v4ri.link/launch", "https://v4ri.link./launch", "https://v4ri.link:8443/launch", "https://admin.v4ri.link/", "https://preview.v4ri.link/launch"])(
    "rejects unsafe destination %s without creating a record", async (destination) => {
      await expect(createLink({ database: env.DB, configuration, administrator, draft: { ...draft, destination } })).rejects.toMatchObject({ status: 400 });
      expect(await exportLinks(env.DB)).toEqual([]);
    },
  );

  it("canonicalises future expiry, rejects elapsed expiry and can clear expiry", async () => {
    const expiry = new Date(Date.now() + 60_000).toISOString();
    await createLink({ database: env.DB, configuration, administrator, draft: { ...draft, slug: "launch", expiresAt: expiry } });
    expect(await getLink(env.DB, "launch")).toMatchObject({ expiresAt: expiry });
    await expect(updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { expiresAt: "2000-01-01T00:00:00Z" } })).rejects.toMatchObject({ status: 400 });
    await updateLink({ database: env.DB, configuration, administrator, slug: "launch", patch: { expiresAt: null } });
    expect(await getLink(env.DB, "launch")).toMatchObject({ expiresAt: null });
  });

  it("paginates without duplicates and treats SQL search wildcards literally", async () => {
    for (let index = 0; index < 53; index += 1) {
      await create(`link-${index}`);
    }
    const firstPage = await listLinks(env.DB, { search: "" });
    expect(firstPage.links).toHaveLength(50);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listLinks(env.DB, { search: "", cursor: firstPage.nextCursor ?? "" });
    expect(secondPage.links).toHaveLength(3);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.links, ...secondPage.links].map((link) => link.slug)).size).toBe(53);
    expect((await listLinks(env.DB, { search: "%" })).links).toEqual([]);
    await expect(listLinks(env.DB, { search: "", cursor: "invalid" })).rejects.toMatchObject({ status: 400 });
  });
});
