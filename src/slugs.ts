import { MAXIMUM_CUSTOM_SLUG_LENGTH } from "../shared/contracts";

export const INITIAL_SYLLABLE_COUNT = 3;

const CHARACTERS_PER_SYLLABLE = 2;
const MAXIMUM_SYLLABLE_COUNT = MAXIMUM_CUSTOM_SLUG_LENGTH / CHARACTERS_PER_SYLLABLE;
const MAXIMUM_GENERATION_ATTEMPTS = 32;
const RESERVED_SLUGS = new Set([
  "api", "admin", "assets", "health", "preview", "favicon", "robots", "index", "cdn-cgi",
]);

// a power-of-two vocabulary permits unbiased sampling without rejection loops.
const SYLLABLES = [
  "ba", "be", "bi", "bo", "bu", "da", "de", "di",
  "do", "du", "ga", "ge", "gi", "go", "gu", "ka",
  "ke", "ki", "ko", "ku", "la", "le", "li", "lo",
  "lu", "ma", "me", "mi", "mo", "mu", "na", "ne",
  "ni", "no", "nu", "pa", "pe", "pi", "po", "pu",
  "ra", "re", "ri", "ro", "ru", "ta", "te", "ti",
  "to", "tu", "va", "ve", "vi", "vo", "vu", "za",
  "ze", "zi", "zo", "zu", "wa", "we", "wi", "wo",
] as const;
const SYLLABLE_MASK = SYLLABLES.length - 1;
const SYLLABLE_SET = new Set<string>(SYLLABLES);

// this conservative list covers English and selected common romanisations; it cannot cover every language.
const BLOCKED_FRAGMENTS = [
  "anal", "anus", "arse", "ass", "bastard", "bitch", "bollock", "boob", "cock",
  "crap", "cum", "cunt", "dick", "dyke", "fag", "fuck", "nigg", "niger", "paki",
  "kike", "chink", "gook", "coon", "spic", "nazi", "hitler", "pedo", "porn", "pussy",
  "rape", "retard", "sex", "shit", "slut", "tit", "tranny", "twat", "wank", "whore",
  "puta", "puto", "pendej", "joder", "mierda", "cabron", "kurwa", "blyat", "suka",
  "cyka", "chuti", "madarchod", "bhenchod", "lund", "randi", "puki", "kimak",
  "kontol", "memek", "babi", "bodoh", "kanina", "kannina", "lanjiao", "cibai",
  "cheebai", "nima", "punda", "thevdi", "soothu",
] as const;

function normalisePronunciation(value: string): string {
  return value
    .replace(/ph/g, "f")
    .replace(/qu/g, "k")
    .replace(/[cq]/g, "k")
    .replace(/v/g, "f")
    .replace(/z/g, "s")
    .replace(/y/g, "i")
    .replace(/(.)\1+/g, "$1")
    .replace(/[aeiou]/g, "a");
}

const BLOCKED_PRONUNCIATIONS = BLOCKED_FRAGMENTS.map(normalisePronunciation);

export function parseCustomSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0 || slug.length > MAXIMUM_CUSTOM_SLUG_LENGTH) {
    return null;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || RESERVED_SLUGS.has(slug)) {
    return null;
  }
  return slug;
}

export function isSafeGeneratedSlug(raw: string): boolean {
  if (raw.length < INITIAL_SYLLABLE_COUNT * CHARACTERS_PER_SYLLABLE
    || raw.length > MAXIMUM_CUSTOM_SLUG_LENGTH
    || !/^(?:[a-z][aeiou])+$/.test(raw)) {
    return false;
  }
  for (let characterOffset = 0; characterOffset < raw.length; characterOffset += CHARACTERS_PER_SYLLABLE) {
    if (!SYLLABLE_SET.has(raw.slice(characterOffset, characterOffset + CHARACTERS_PER_SYLLABLE))) {
      return false;
    }
  }
  const pronunciation = normalisePronunciation(raw);
  return !BLOCKED_FRAGMENTS.some((fragment) => raw.includes(fragment))
    && !BLOCKED_PRONUNCIATIONS.some((fragment) => pronunciation.includes(fragment));
}

function generateCandidate(syllableCount: number): string {
  const randomValues = crypto.getRandomValues(new Uint8Array(syllableCount));
  return Array.from(randomValues, (randomValue) => SYLLABLES[randomValue & SYLLABLE_MASK]).join("");
}

function generateFallback(syllableCount: number): string {
  // m plus vowels cannot spell any blocked fragment, even across syllable boundaries.
  const randomValues = crypto.getRandomValues(new Uint8Array(syllableCount));
  const fallbackSyllables = ["ma", "me", "mi", "mo"] as const;
  const fallbackMask = fallbackSyllables.length - 1;
  return Array.from(randomValues, (randomValue) => fallbackSyllables[randomValue & fallbackMask]).join("");
}

export function generateSlug(syllableCount: number): string {
  if (!Number.isInteger(syllableCount)
    || syllableCount < INITIAL_SYLLABLE_COUNT
    || syllableCount > MAXIMUM_SYLLABLE_COUNT) {
    throw new RangeError(`Syllable count must be between ${INITIAL_SYLLABLE_COUNT} and ${MAXIMUM_SYLLABLE_COUNT}.`);
  }
  for (let attemptCount = 0; attemptCount < MAXIMUM_GENERATION_ATTEMPTS; attemptCount += 1) {
    const candidate = generateCandidate(syllableCount);
    if (isSafeGeneratedSlug(candidate)) {
      return candidate;
    }
  }
  return generateFallback(syllableCount);
}
