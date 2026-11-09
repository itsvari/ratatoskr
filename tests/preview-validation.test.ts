import { Buffer } from "node:buffer";
import { constants, deflateRawSync, inflateSync } from "node:zlib";
import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { compressPreviewSection } from "../shared/preview-compression";
import { PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT, PREVIEW_IMAGE_WIDTH, PREVIEW_SCANLINE_BYTES, type PreviewSegment } from "../shared/preview-image";
import { validatePreviewSegment } from "../src/preview-segment";

const ORIGIN = "http://localhost:5173";
const HEADERS = { "Content-Type": "application/json", Origin: ORIGIN };
const pixels = new Uint8Array(PREVIEW_IMAGE_WIDTH * PREVIEW_IMAGE_HEIGHT * 4);
const header = compressPreviewSection(pixels, 0, PREVIEW_HEADER_HEIGHT);
const body = compressPreviewSection(pixels, PREVIEW_HEADER_HEIGHT, PREVIEW_IMAGE_HEIGHT);

function section(scanlines: Uint8Array, finishFlush = constants.Z_SYNC_FLUSH): PreviewSegment {
  let low = 1;
  let high = 0;
  for (const byte of scanlines) {
    low = (low + byte) % 65521;
    high = (high + low) % 65521;
  }
  return { compressed: deflateRawSync(scanlines, { finishFlush }).toString("base64"), checksum: ((high << 16) | low) >>> 0 };
}

function invalidSections(height: number, segment: PreviewSegment): { name: string; segment: PreviewSegment }[] {
  const scanlines = new Uint8Array(height * PREVIEW_SCANLINE_BYTES);
  const filtered = scanlines.slice();
  filtered[PREVIEW_SCANLINE_BYTES] = 1;
  const finished = Buffer.from(section(scanlines, constants.Z_FINISH).compressed, "base64");
  const valid = Buffer.from(segment.compressed, "base64");
  return [
    { name: "garbage", segment: { compressed: "AAAAAAAA", checksum: 0 } },
    { name: "checksum", segment: { ...segment, checksum: (segment.checksum ^ 1) >>> 0 } },
    { name: "short output", segment: section(scanlines.subarray(0, scanlines.length - PREVIEW_SCANLINE_BYTES)) },
    { name: "filter", segment: section(filtered) },
    { name: "truncated sync flush", segment: { ...segment, compressed: valid.subarray(0, valid.length - 1).toString("base64") } },
    { name: "premature final block", segment: { ...segment, compressed: Buffer.concat([finished, Buffer.from([0, 0, 255, 255])]).toString("base64") } },
    { name: "trailing data", segment: { ...segment, compressed: Buffer.concat([valid, Buffer.from([1, 0, 0, 255, 255, 0, 0, 255, 255])]).toString("base64") } },
    { name: "oversized output", segment: section(new Uint8Array(scanlines.length + PREVIEW_SCANLINE_BYTES)) },
    { name: "invalid base64", segment: { ...segment, compressed: "!!!!" } },
  ];
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE preview_branding SET segment = NULL WHERE singleton = 1"),
    env.DB.prepare("DELETE FROM preview_images"), env.DB.prepare("DELETE FROM site_settings_audit"),
    env.DB.prepare("DELETE FROM audit_events"), env.DB.prepare("DELETE FROM links"),
    env.DB.prepare("DELETE FROM administrators"),
    env.DB.prepare("UPDATE site_settings SET display_name = 'Ratatoskr', home_redirect_url = NULL WHERE singleton = 1"),
  ]);
});

it("accepts compressor sections and decodes the complete assembled PNG", async () => {
  expect(validatePreviewSegment(header, "header")).toBe(header);
  expect(validatePreviewSegment(body, "body")).toBe(body);
  const create = await SELF.fetch(`${ORIGIN}/api/links`, { method: "POST", headers: HEADERS,
    body: JSON.stringify({ slug: "preview-validation", title: "Notes", destination: "https://example.com" }) });
  expect(create.status).toBe(201);
  const upload = await SELF.fetch(`${ORIGIN}/api/links/preview-validation/image`, { method: "POST", headers: HEADERS,
    body: JSON.stringify({ title: "Notes", destination: "https://example.com/", origin: ORIGIN, segment: body }) });
  expect(upload.status).toBe(204);
  const response = await SELF.fetch(`${ORIGIN}/_preview/preview-validation.png`);
  expect(response.status).toBe(200);
  const png = new Uint8Array(await response.arrayBuffer());
  const lengthBytes = new DataView(png.buffer).getUint32(33);
  const decoded = inflateSync(png.subarray(41, 41 + lengthBytes));
  expect(decoded.length).toBe(PREVIEW_IMAGE_HEIGHT * PREVIEW_SCANLINE_BYTES);
  expect(decoded.subarray(PREVIEW_HEADER_HEIGHT * PREVIEW_SCANLINE_BYTES).every((byte) => byte === 0)).toBe(true);
});

it("rejects malformed sections without changing images, branding or audits", async () => {
  expect((await SELF.fetch(`${ORIGIN}/api/links`, { method: "POST", headers: HEADERS,
    body: JSON.stringify({ slug: "preview-validation", title: "Notes", destination: "https://example.com" }) })).status).toBe(201);
  const upload = (segment: PreviewSegment) => SELF.fetch(`${ORIGIN}/api/links/preview-validation/image`, { method: "POST", headers: HEADERS,
    body: JSON.stringify({ title: "Notes", destination: "https://example.com/", origin: ORIGIN, segment }) });
  const save = (segment: PreviewSegment) => SELF.fetch(`${ORIGIN}/api/settings`, { method: "PATCH", headers: HEADERS,
    body: JSON.stringify({ displayName: "Custom", homeRedirectUrl: null, previewHeader: segment }) });
  expect((await upload(body)).status).toBe(204);
  expect((await save(header)).status).toBe(200);
  const imageBefore = await env.DB.prepare("SELECT * FROM preview_images").first();
  const brandingBefore = await env.DB.prepare("SELECT * FROM preview_branding").first();
  const auditBefore = await env.DB.prepare("SELECT * FROM site_settings_audit").all();
  for (const invalid of invalidSections(PREVIEW_IMAGE_HEIGHT - PREVIEW_HEADER_HEIGHT, body)) {
    expect((await upload(invalid.segment)).status, `body: ${invalid.name}`).toBe(400);
    expect(() => validatePreviewSegment(invalid.segment, "body"), `body: ${invalid.name}`).toThrowError(expect.objectContaining({ status: 400 }));
  }
  for (const invalid of invalidSections(PREVIEW_HEADER_HEIGHT, header)) {
    expect((await save(invalid.segment)).status, `header: ${invalid.name}`).toBe(400);
    expect(() => validatePreviewSegment(invalid.segment, "header"), `header: ${invalid.name}`).toThrowError(expect.objectContaining({ status: 400 }));
  }
  expect(await env.DB.prepare("SELECT * FROM preview_images").first()).toEqual(imageBefore);
  expect(await env.DB.prepare("SELECT * FROM preview_branding").first()).toEqual(brandingBefore);
  expect(await env.DB.prepare("SELECT * FROM site_settings_audit").all()).toEqual(auditBefore);
});
