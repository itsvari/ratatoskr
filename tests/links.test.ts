import { env } from "cloudflare:test";
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
    await expect(deleteLink(env.DB, "launch", administrator)).rejects.toMatchObject({ status: 404 });
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
