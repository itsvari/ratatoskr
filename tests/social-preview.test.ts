import { afterEach, describe, expect, it, vi } from "vitest";
import { destinationHasPreviewImage, isPreviewCrawler } from "../src/social-preview";

const DESTINATION = "https://example.com/article";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function htmlResponse(head: string): Response {
  return new Response(`<html><head>${head}</head><body></body></html>`, { headers: { "Content-Type": "text/html" } });
}

describe("Social preview detection", () => {
  it.each(["facebookexternalhit/1.1", "Twitterbot/1.0", "LinkedInBot", "Slackbot-LinkExpanding", "Discordbot/2.0", "TelegramBot", "WhatsApp/2.0"])("recognises %s", (userAgent) => {
    expect(isPreviewCrawler(userAgent)).toBe(true);
  });

  it.each(["", "Mozilla/5.0 Chrome/143.0", "Googlebot/2.1"])("keeps ordinary redirects for %s", (userAgent) => {
    expect(isPreviewCrawler(userAgent)).toBe(false);
  });

  it.each([
    '<META CONTENT="/cover.png" PROPERTY="og:image">',
    '<meta name="twitter:image" content="https://cdn.example.com/cover.jpg">',
    '<meta property="og:image:secure_url" content="//cdn.example.com/cover.jpg">',
    '<meta property="og:image:url" content="cover.jpg">',
    '<meta name="twitter:image:src" content="/cover.jpg">',
  ])("recognises usable image metadata: %s", async (meta) => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(meta)));
    expect(await destinationHasPreviewImage(DESTINATION, [])).toBe(true);
  });

  it.each([
    '<meta property="og:title" content="Title only">',
    '<meta property="og:image" content="  ">',
    '<meta property="og:image" content="javascript:alert(1)">',
    '<meta property="og:image" content="data:image/png;base64,test">',
    '<!-- <meta property="og:image" content="/fake.png"> -->',
    '<script>const markup = \'<meta property="og:image" content="/fake.png">\';</script>',
  ])("generates a fallback for absent or unusable metadata: %s", async (meta) => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(meta)));
    expect(await destinationHasPreviewImage(DESTINATION, [])).toBe(false);
  });

  it("follows bounded relative redirects and checks metadata on the final page", async () => {
    const outbound = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "/moved" } }))
      .mockResolvedValueOnce(htmlResponse('<meta property="og:image" content="/cover.png">'));
    vi.stubGlobal("fetch", outbound);
    expect(await destinationHasPreviewImage(DESTINATION, [])).toBe(true);
    expect(outbound.mock.calls[1]?.[0]).toEqual(new URL("https://example.com/moved"));
  });

  it("bounds redirect loops", async () => {
    const outbound = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "/loop" } }));
    vi.stubGlobal("fetch", outbound);
    expect(await destinationHasPreviewImage(DESTINATION, [])).toBe(false);
    expect(outbound).toHaveBeenCalledTimes(4);
  });

  it.each(["http://127.0.0.1/", "http://0x7f000001/", "http://[::1]/", "http://169.254.169.254/", "http://localhost/", "http://service.internal/", "https://example.com:8443/", "https://owner:secret@example.com/", "https://links.example.com/other"])("never fetches restricted destinations or redirect targets: %s", async (target) => {
    const outbound = vi.fn(async () => new Response(null, { status: 302, headers: { Location: target } }));
    vi.stubGlobal("fetch", outbound);
    const excludedOrigins = ["https://links.example.com"];
    expect(await destinationHasPreviewImage(target, excludedOrigins)).toBe(false);
    expect(outbound).not.toHaveBeenCalled();
    expect(await destinationHasPreviewImage(DESTINATION, excludedOrigins)).toBe(false);
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it.each([new Response("failure", { status: 503 }), new Response("not HTML", { headers: { "Content-Type": "application/pdf" } })])("falls back for unsuccessful or non-HTML responses", async (response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    expect(await destinationHasPreviewImage(DESTINATION, [])).toBe(false);
  });

  it("falls back on network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network failure")));
    expect(await destinationHasPreviewImage(DESTINATION, [])).toBe(false);
  });

  it("stops reading after 64 KiB and cancels the response body", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`<html><head>${" ".repeat(65_536)}<meta property="og:image" content="/too-late.png">`));
      }, cancel: cancelled,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "Content-Type": "text/html" } })));
    expect(await destinationHasPreviewImage(DESTINATION, [])).toBe(false);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("aborts a stalled metadata fetch after two seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: unknown, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
    })));
    const result = destinationHasPreviewImage(DESTINATION, []);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await result).toBe(false);
  });
});
