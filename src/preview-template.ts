import { DEFAULT_DISPLAY_NAME, type Link } from "../shared/contracts";
import { escapeHtml } from "./preview";
import { PREVIEW_IMAGE_HEIGHT, PREVIEW_IMAGE_WIDTH } from "./preview-dimensions";

function shorten(value: string, maximumLength: number): string {
  const characters = Array.from(value.replace(/[\u0000-\u001f\u007f]/g, " "));
  return characters.length > maximumLength ? `${characters.slice(0, maximumLength - 1).join("")}…` : characters.join("");
}

function titleLines(value: string): readonly string[] {
  let remaining = Array.from(value.replace(/\s+/g, " ").trim());
  const lines: string[] = [];
  for (let line = 0; line < 3 && remaining.length > 0; line += 1) {
    if (remaining.length <= 24) {
      lines.push(remaining.join(""));
      break;
    }
    if (line === 2) {
      lines.push(`${remaining.slice(0, 23).join("")}…`);
      break;
    }
    const lastSpace = remaining.slice(0, 25).lastIndexOf(" ");
    const boundary = lastSpace >= 12 ? lastSpace : 24;
    lines.push(remaining.slice(0, boundary).join(""));
    remaining = remaining.slice(boundary);
    if (remaining[0] === " ") remaining.shift();
  }
  return lines;
}

export function renderPreviewSvg(link: Link, shortOrigin: string, displayName = DEFAULT_DISPLAY_NAME): string {
  const destination = new URL(link.destination);
  const title = shorten(link.title || destination.hostname, 120);
  const shortlink = `${new URL(shortOrigin).host}/${link.slug}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_IMAGE_WIDTH}" height="${PREVIEW_IMAGE_HEIGHT}" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#000"/>
    <rect x="32" y="32" width="1136" height="566" rx="24" fill="#0c0c0c" stroke="#303030" stroke-width="2"/>
    <rect x="72" y="80" width="8" height="32" rx="4" fill="#8b5cf6"/>
    <g font-family="Inter" fill="#eee">
      <text x="100" y="106" font-size="28" font-weight="600" fill="#a78bfa">${escapeHtml(displayName)}</text>
      ${titleLines(title).map((line, index) => `<text x="72" y="${202 + index * 52}" font-size="44" font-weight="700">${escapeHtml(line)}</text>`).join("")}
      <text x="72" y="366" font-size="24" fill="#aaa">This shortlink points to</text>
      <rect x="72" y="390" width="1056" height="80" rx="10" fill="#141414" stroke="#303030"/>
      <text x="96" y="441" font-size="24">${escapeHtml(shorten(destination.host, 40))}</text>
      <text x="72" y="536" font-size="22" fill="#a78bfa">${escapeHtml(shorten(shortlink, 44))}</text>
      <path d="M1080 514h28m-12-12 12 12-12 12" fill="none" stroke="#a78bfa" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
  </svg>`;
}

