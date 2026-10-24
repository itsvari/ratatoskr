import { previewAdvance, previewFontFamily } from "./assets/fallback-fonts";
import { escapeHtml } from "./preview";
import bidiFactory from "bidi-js";

const bidi = bidiFactory();

export function renderPreviewText(text: string, options: {
  readonly x: number; readonly y: number; readonly fontSize: number; readonly maximumWidth: number;
  readonly fontWeight: number; readonly fill?: string;
}): string {
  const runs: { family: string; text: string; advance: number; level: number }[] = [];
  const embedding = bidi.getEmbeddingLevels(text, "ltr");
  const runAtIndex: number[] = [];
  let index = 0;
  for (const character of text) {
    const previous = runs.at(-1);
    // Keep combining marks and joiners with their base so Arabic shaping is not split.
    const mark = /[\p{M}\p{Cf}]/u.test(character);
    const family = previous && mark
      ? previous.family : previewFontFamily(character.codePointAt(0)!);
    const level = embedding.levels[index] ?? 0;
    const displayed = (level & 1) && family !== "Preview Arabic" ? bidi.getMirroredCharacter(character) ?? character : character;
    const advance = mark ? 0 : previewAdvance(character.codePointAt(0)!);
    if (previous?.family === family && previous.level === level) {
      previous.text += displayed;
      previous.advance += advance;
    } else runs.push({ family, text: displayed, advance, level });
    for (let unit = 0; unit < character.length; unit += 1) runAtIndex[index + unit] = runs.length - 1;
    index += character.length;
  }
  const advance = runs.reduce((total, run) => total + run.advance, 0);
  const fontSize = Math.min(options.fontSize, options.maximumWidth / (advance || 1));
  let x = options.x;
  // Separate text elements avoid resvg dropping a multi-font bidi text chunk.
  // Native shaping still sees each complete Arabic run, including its joining marks.
  const visualRuns = [...new Set(bidi.getReorderedIndices(text, embedding).map((index) => runAtIndex[index]!))];
  return visualRuns.map((index) => {
    const run = runs[index]!;
    const svg = `<text x="${x}" y="${options.y}" font-family="${run.family}" font-size="${fontSize}" font-weight="${options.fontWeight}"${options.fill ? ` fill="${options.fill}"` : ""}>${escapeHtml(run.text)}</text>`;
    x += run.advance * fontSize;
    return svg;
  }).join("");
}
