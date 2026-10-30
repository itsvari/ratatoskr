import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const REPEATED_IMAGE_SAMPLES = 20;
const VARIED_IMAGE_SAMPLES = 30;
const HEAD_SAMPLES = 10;
const CONCURRENT_IMAGE_SAMPLES = 8;
const FIRST_CONCURRENT_SLUG = 31;
const READINESS_RETRY_MS = 1000;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

const { values } = parseArgs({ options: {
  origin: { type: "string" }, worker: { type: "string" }, phase: { type: "string", default: "stored" },
  output: { type: "string", default: "verification-artifacts/deployed-preview.json" },
  "events-only": { type: "boolean", default: false },
} });
const origin = z.url().parse(values.origin);
const worker = z.string().regex(/^ratatoskr-preview-cpu-[a-z0-9-]+$/).parse(values.worker);
if (!new URL(origin).hostname.startsWith(`${worker}.`) || !new URL(origin).hostname.endsWith(".workers.dev")) {
  throw new Error("Use only the isolated staging Worker's workers.dev origin.");
}
const phase = z.string().regex(/^[a-z0-9-]+$/).parse(values.phase);
const startedAt = Date.now();
const samples: { readonly kind: string; readonly sequence: number; readonly status: number; readonly bytes: number; readonly isolate: string | null; readonly isolateSequence: string | null }[] = [];
let nextSequence = 0;
async function request(index: number, kind: string, method = "GET") {
  const sequence = nextSequence++;
  const response = await fetch(`${origin}/_preview/sample-${index}.png?case=${phase}-${kind}-${sequence}`, { method });
  const bytes = await response.arrayBuffer();
  const sample = { kind, sequence, status: response.status, bytes: bytes.byteLength,
    isolate: response.headers.get("X-Profile-Isolate"), isolateSequence: response.headers.get("X-Profile-Sequence") };
  samples.push(sample);
  return { ...sample, platformMiss: response.status === 404 && response.headers.get("Cache-Control") !== "no-store" };
}
if (!values["events-only"]) {
  const maximumReadinessAttempts = 30;
  for (let attempt = 0; attempt < maximumReadinessAttempts; attempt += 1) {
    const first = await request(0, "first");
    if (!first.platformMiss) break;
    if (attempt === maximumReadinessAttempts - 1) throw new Error("The staging hostname did not become ready.");
    await new Promise((resolve) => setTimeout(resolve, READINESS_RETRY_MS));
  }
  for (let index = 0; index < REPEATED_IMAGE_SAMPLES; index += 1) await request(0, "repeat");
  for (let index = 1; index <= VARIED_IMAGE_SAMPLES; index += 1) await request(index, "varied");
  for (let index = 0; index < HEAD_SAMPLES; index += 1) await request(index, "head", "HEAD");
  await Promise.all(Array.from({ length: CONCURRENT_IMAGE_SAMPLES }, (_, index) => request(index + FIRST_CONCURRENT_SLUG, "concurrent")));
  await request(0, "revisit");
}
const query = { queryId: "preview-performance", view: "events", limit: 1000,
  timeframe: { from: startedAt - MILLISECONDS_PER_HOUR, to: Date.now() },
  parameters: { limit: 1000, filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: worker }] } };
await mkdir(dirname(values.output!), { recursive: true });
const queryPath = `${values.output}.query.json`;
await writeFile(queryPath, JSON.stringify(query));
const raw = execFileSync(process.env.CF_EXECUTABLE ?? "cf", ["o11y", "telemetry", "query", "--body", `@${queryPath}`], {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
const payload: unknown = JSON.parse(raw);
const parsed = z.object({ events: z.object({ events: z.array(z.object({
  $workers: z.object({ cpuTimeMs: z.number().optional(), wallTimeMs: z.number().optional(),
    outcome: z.string().optional(), scriptVersion: z.object({ id: z.string() }).optional(),
    event: z.object({ request: z.object({ url: z.string() }), response: z.object({ status: z.number() }).optional() }).optional(),
  }),
})) }) }).parse(payload);
const invocations = parsed.events.events.flatMap(({ $workers: event }) => {
  if (event.cpuTimeMs === undefined || !event.event) return [];
  const label = new URL(event.event.request.url).searchParams.get("case");
  if (!label?.startsWith(`${phase}-`)) return [];
  return [{ label, cpuTimeMs: event.cpuTimeMs, wallTimeMs: event.wallTimeMs, outcome: event.outcome,
    status: event.event.response?.status, version: event.scriptVersion?.id }];
});
await writeFile(values.output!, JSON.stringify({ recordedAt: new Date().toISOString(), origin, worker, phase,
  method: "Cloudflare invocation cpuTimeMs; wallTimeMs is separate. Logs may arrive late. Rerun --events-only to retrieve them without traffic.",
  samples, invocations }, null, 2));
console.log(`Saved ${samples.length} client results and ${invocations.length} invocation records to ${values.output}.`);
