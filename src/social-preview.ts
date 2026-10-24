const MAXIMUM_METADATA_BYTES = 65_536;
const METADATA_TIMEOUT_MS = 2_000;
const MAXIMUM_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const IMAGE_PROPERTIES = new Set(["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"]);

export function isPreviewCrawler(userAgent: string): boolean {
  return /facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|skypeuripreview|pinterestbot|vkshare|embedly|iframely|redditbot/i.test(userAgent);
}

function canFetchMetadata(url: URL, excludedOrigins: readonly (string | null)[]): boolean {
  const hostname = url.hostname.replace(/\.$/, "");
  return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
    && (!url.port || ["80", "443"].includes(url.port))
    && hostname.includes(".") && !/^[\d.]+$/.test(hostname) && !hostname.includes(":")
    && !/\.(?:localhost|local|internal|test|invalid|example)$/.test(hostname)
    && !excludedOrigins.some((origin) => origin !== null && new URL(origin).hostname.replace(/\.$/, "") === hostname);
}

async function readMetadata(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let html = "";
  try {
    while (bytesRead < MAXIMUM_METADATA_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = chunk.value.subarray(0, MAXIMUM_METADATA_BYTES - bytesRead);
      html += decoder.decode(bytes, { stream: true });
      bytesRead += bytes.byteLength;
      if (/<\/head\s*>/i.test(html)) break;
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

export async function destinationHasPreviewImage(destination: string, excludedOrigins: readonly (string | null)[]): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);
  try {
    let url = new URL(destination);
    for (let redirects = 0; redirects <= MAXIMUM_REDIRECTS; redirects += 1) {
      if (!canFetchMetadata(url, excludedOrigins)) return false;
      // Crawler requests carry no visitor cookies, authentication or other headers.
      const response = await fetch(url, {
        redirect: "manual", signal: controller.signal,
        headers: { Accept: "text/html", "User-Agent": "Ratatoskr/1.0 (link preview metadata)" },
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("Location");
        if (!location) return false;
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !/^text\/html(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
        await response.body?.cancel();
        return false;
      }
      const html = await readMetadata(response);
      let hasImage = false;
      const pageUrl = url;
      await new HTMLRewriter().on("head meta", {
        element(element) {
          const property = (element.getAttribute("property") ?? element.getAttribute("name") ?? "").toLowerCase();
          const content = element.getAttribute("content")?.trim();
          if (!IMAGE_PROPERTIES.has(property) || !content) return;
          try {
            const imageUrl = new URL(content, pageUrl);
            if (["http:", "https:"].includes(imageUrl.protocol)) hasImage = true;
          } catch {
            // An unusable image address should not suppress the generated card.
          }
        },
      }).transform(new Response(html)).arrayBuffer();
      return hasImage;
    }
  } catch {
    // Unreachable, slow or non-HTML destinations still receive a stored-data preview.
  } finally {
    clearTimeout(timeout);
  }
  return false;
}
