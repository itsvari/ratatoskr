import { afterEach, describe, expect, it, vi } from "vitest";
import { MAXIMUM_CUSTOM_SLUG_LENGTH } from "../shared/contracts";
import { generateSlug, INITIAL_SYLLABLE_COUNT, isSafeGeneratedSlug, parseCustomSlug } from "../src/slugs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("custom shortlinks", () => {
  it("normalises pasted names while retaining human-chosen words and digits", () => {
    expect(parseCustomSlug("  Launch-2026  ")).toBe("launch-2026");
    expect(parseCustomSlug("a")).toBe("a");
    expect(parseCustomSlug("9")).toBe("9");
    expect(parseCustomSlug("a".repeat(MAXIMUM_CUSTOM_SLUG_LENGTH))).not.toBeNull();
  });

  it.each(["API", "Admin", "ASSETS", "health", "preview", "favicon", "robots", "index", " CDN-CGI "])(
    "prevents a custom name from shadowing the %s application route",
    (slug) => expect(parseCustomSlug(slug)).toBeNull(),
  );

  it.each(["", " ", "-slug", "slug-", "two--hyphens", "has space", "foo/bar", "foo+", "foo?", "foo#", "%61dmin", "résumé", "a\u0000b"])(
    "rejects malformed path identifier %j",
    (slug) => expect(parseCustomSlug(slug)).toBeNull(),
  );

  it("enforces the public length limit", () => {
    expect(parseCustomSlug("a".repeat(MAXIMUM_CUSTOM_SLUG_LENGTH + 1))).toBeNull();
  });
});

describe("generated shortlinks", () => {
  it.each(["mavetu", "nokapi", "zupena", "mamemimomamemimo"])(
    "accepts pronounceable screened name %s",
    (slug) => expect(isSafeGeneratedSlug(slug)).toBe(true),
  );

  it.each([
    "mapaki", "badika", "nigama", "baputa", "marape", "napuki", "naziwa",
    "nevuka", "pukeme", "negama", "pakama", "vapuki",
  ])("screens offensive fragments and approximate pronunciations in %s", (slug) => {
    expect(isSafeGeneratedSlug(slug)).toBe(false);
  });

  it.each(["Mavetu", "ma-ve-tu", "mave1u", "ma", "mav", "xxxxxx", "mavetu+", "😀mave", "ma".repeat(25)])(
    "rejects invalid generated identifier %j",
    (slug) => expect(isSafeGeneratedSlug(slug)).toBe(false),
  );

  it("grows beyond six characters without changing the syllable format", () => {
    for (const syllableCount of [INITIAL_SYLLABLE_COUNT, 4, 6, 12, 24]) {
      const slug = generateSlug(syllableCount);
      expect(slug).toHaveLength(syllableCount * 2);
      expect(slug).toMatch(/^(?:[a-z][aeiou])+$/);
      expect(isSafeGeneratedSlug(slug)).toBe(true);
      expect(parseCustomSlug(slug)).toBe(slug);
    }
  });

  it("retains random variation among screened generated names", () => {
    const generated = Array.from({ length: 100 }, () => generateSlug(INITIAL_SYLLABLE_COUNT));
    expect(new Set(generated).size).toBeGreaterThan(90);
    expect(generated.every(isSafeGeneratedSlug)).toBe(true);
  });

  it("terminates safely when the random source repeatedly chooses a rejected word", () => {
    const randomSource = vi.spyOn(crypto, "getRandomValues").mockImplementation((values) => {
      if (!(values instanceof Uint8Array)) {
        throw new TypeError("Expected bytes for syllable generation.");
      }
      values.set([35, 17, 25]);
      return values;
    });
    const slug = generateSlug(INITIAL_SYLLABLE_COUNT);
    expect(slug).toHaveLength(6);
    expect(isSafeGeneratedSlug(slug)).toBe(true);
    expect(slug).toMatch(/^(?:m[aeio])+$/);
    expect(randomSource.mock.calls.length).toBeLessThanOrEqual(40);
  });

  it.each([0, 2, 3.5, 25, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid syllable count %s before allocating randomness",
    (syllableCount) => expect(() => generateSlug(syllableCount)).toThrow(RangeError),
  );
});
