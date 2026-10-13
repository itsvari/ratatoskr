import type { Link } from "../shared/contracts";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return character;
    }
  });
}

function document(title: string, content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>${escapeHtml(title)} · Ratatoskr</title><style>
  @font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;src:url('/_fonts/inter.woff2') format('woff2')}@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:100 800;font-display:swap;src:url('/_fonts/jetbrains-mono.woff2') format('woff2')}:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#000;color:#eee;font:16px/1.6 Inter,system-ui,sans-serif}main{max-width:650px;margin:12vh auto;padding:28px}small{color:#a78bfa;font-weight:600}h1{font-size:30px;line-height:1.2;margin:24px 0}p{color:#aaa}code{display:block;font-family:'JetBrains Mono',monospace;border:1px solid #303030;border-radius:8px;padding:20px;color:#e5e5e5;overflow-wrap:anywhere;margin:24px 0}a{color:#a78bfa}a.button{display:inline-block;background:#8b5cf6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600}:focus-visible{outline:3px solid #a78bfa;outline-offset:4px}@media(max-width:500px){main{margin:5vh auto;padding:24px}h1{font-size:26px}}
  </style></head><body><main><small>Ratatoskr</small>${content}</main></body></html>`;
}

export function renderPreview(link: Link): Response {
  const destination = new URL(link.destination);
  const title = link.title || destination.hostname;
  return new Response(document("Destination preview", `<h1>${escapeHtml(title)}</h1><p>This shortlink points to <strong>${escapeHtml(destination.hostname)}</strong>.</p><code>${escapeHtml(link.destination)}</code><a class="button" href="${escapeHtml(link.destination)}" rel="noopener noreferrer nofollow">Continue to destination</a><p>This preview shows the stored address. It does not verify the website's safety or any further redirects.</p>`), {
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" },
  });
}

export function renderUnavailable(status: 404 | 410 | 429 | 503): Response {
  const title = status === 429 ? "Too many requests" : status === 503 ? "Temporarily unavailable" : "Link unavailable";
  const description = status === 429 ? "Please wait a minute before trying again."
    : status === 503 ? "Please try again shortly." : "This shortlink does not exist, has expired, or has been withdrawn.";
  return new Response(document(title, `<h1>${title}</h1><p>${description}</p>`), {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

export function renderHome(adminUrl: string): Response {
  return new Response(document("Shortlinks", `<h1>Shortlinks</h1><p>Append <strong>+</strong> to preview a destination.</p><p><a href="${escapeHtml(adminUrl)}">Manage links</a></p>`), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
