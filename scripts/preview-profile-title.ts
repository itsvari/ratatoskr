import { z } from "zod";

// mirrors MAXIMUM_TITLE_LENGTH in shared/contracts.ts, which scripts cannot import.
const MAXIMUM_TITLE_LENGTH = 120;

// each varied sample appends " <index>", so the reserve is the space plus the digits of the largest index actually used.
// reserving less would let a sample title exceed the contract, and reserving more would reject titles that fit.
export function parseProfileTitle(title: unknown, sampleCount: number): string {
  const largestIndexDigits = String(sampleCount - 1).length;
  const variedSuffixLength = 1 + largestIndexDigits;
  return z.string().max(MAXIMUM_TITLE_LENGTH - variedSuffixLength).parse(title);
}
