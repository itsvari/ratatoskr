import { readFileSync } from "node:fs";
import { z } from "zod";
import { cloudflare, deploymentStateSchema, DEPLOYMENT_STATE_PATH } from "./cloudflare.ts";
import { deploymentRequest } from "./deployment-http.ts";

const state = deploymentStateSchema.parse(JSON.parse(readFileSync(DEPLOYMENT_STATE_PATH, "utf8")));
const identifier = crypto.randomUUID();
const slug = `verification-${identifier.replaceAll("-", "")}`;
const subject = `verification:${identifier}`;
const initialDestination = "https://example.com/verification";
const revisedDestination = "https://example.org/verification";
const timestamp = new Date().toISOString();
const queryResultsSchema = z.array(z.object({ success: z.literal(true) }));

function query(sql: string, params: readonly string[]): void {
  cloudflare(["d1", "query", state.databaseId, "--body", JSON.stringify({ sql, params })], queryResultsSchema);
}

async function expectResolution(status: number, destination?: string): Promise<void> {
  const response = await deploymentRequest(`${state.shortOrigin}/${slug}`);
  if (response.status !== status || response.headers.get("Cache-Control") !== "no-store") {
    throw new Error(`Expected uncached ${status}, received ${response.status}.`);
  }
  if (destination !== undefined && response.headers.get("Location") !== destination) {
    throw new Error("The redirect did not use the current destination.");
  }
}

async function expectPreviews(status: number, destination?: string): Promise<void> {
  const urls = [`${state.shortOrigin}/${slug}+`];
  if (state.previewOrigin) urls.push(`${state.previewOrigin}/${slug}`);
  for (const url of urls) {
    const response = await deploymentRequest(url);
    const body = await response.text();
    if (response.status !== status || response.headers.get("Cache-Control") !== "no-store") {
      throw new Error(`Expected uncached preview ${status}, received ${response.status}.`);
    }
    if (destination !== undefined && !body.includes(destination)) throw new Error("Preview omitted the current destination.");
  }
}

// this opt-in check writes only its uniquely named fixture, without bypassing Access in the Worker.
try {
  query("INSERT INTO administrators (subject, email) VALUES (?, ?)", [subject, "verification@example.com"]);
  query("INSERT INTO links (slug, title, destination, status, created_at, updated_at, created_by) VALUES (?, '', ?, 'active', ?, ?, ?)",
    [slug, initialDestination, timestamp, timestamp, subject]);
  await expectResolution(302, initialDestination);
  await expectPreviews(200, initialDestination);
  query("UPDATE links SET destination = ? WHERE slug = ? AND created_by = ?", [revisedDestination, slug, subject]);
  await expectResolution(302, revisedDestination);
  await expectPreviews(200, revisedDestination);
  query("UPDATE links SET status = 'revoked' WHERE slug = ? AND created_by = ?", [slug, subject]);
  await expectResolution(410);
  await expectPreviews(410);
  query("UPDATE links SET status = 'active' WHERE slug = ? AND created_by = ?", [slug, subject]);
  await expectResolution(302, revisedDestination);
  query("UPDATE links SET status = 'deleted', destination = NULL, title = '', expires_at = NULL WHERE slug = ? AND created_by = ?", [slug, subject]);
  await expectResolution(404);
  await expectPreviews(404);
  console.info("Verified live redirects, both preview routes, destination changes, revocation, restoration and deletion.");
} finally {
  // test fixtures are removed entirely; ordinary application deletion still reserves slugs permanently.
  query("DELETE FROM links WHERE slug = ? AND created_by = ?", [slug, subject]);
  query("DELETE FROM administrators WHERE subject = ?", [subject]);
}
