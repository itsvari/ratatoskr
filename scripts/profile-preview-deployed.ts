import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { checkIdentity, publishReport, readReport, type ProfileReport } from "./preview-profile-report.ts";

const REPEATED_IMAGE_SAMPLES = 20;
const VARIED_IMAGE_SAMPLES = 30;
const HEAD_SAMPLES = 10;
const CONCURRENT_IMAGE_SAMPLES = 8;
const FIRST_CONCURRENT_SLUG = 31;
const READINESS_RETRY_MS = 1000;
const TELEMETRY_LIMIT = 1000;

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
const output = z.string().parse(values.output);
await mkdir(dirname(output), { recursive: true });
let previousContents: string | null = null;
let previousReport: ProfileReport | null = null;
if (values["events-only"]) {
  const previous = await readReport(output);
  previousReport = previous.report;
  previousContents = previous.contents;
  checkIdentity(previousReport, { origin, worker, phase, runId: previousReport.runId });
} else {
  try { previousContents = await readFile(output, "utf8"); } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
const runId = previousReport?.runId ?? randomUUID();
const measurementStartedAt = previousReport?.measurementStartedAt ?? new Date().toISOString();
const samples: ProfileReport["samples"] = [];
let nextSequence = 0;
async function request(index: number, kind: string, method = "GET") {
  const sequence = nextSequence++;
  const response = await fetch(`${origin}/_preview/sample-${index}.png?case=${phase}-${runId}-${kind}-${sequence}`, { method });
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
const measurementEndedAt = previousReport?.measurementEndedAt ?? new Date().toISOString();
const query = { queryId: "preview-performance", view: "events", limit: TELEMETRY_LIMIT,
  timeframe: { from: Date.parse(measurementStartedAt), to: Date.parse(measurementEndedAt) },
  parameters: { limit: TELEMETRY_LIMIT, filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: worker }] } };
const queryPath = `${output}.${randomUUID()}.query.json`;
let raw: string;
try {
  await writeFile(queryPath, JSON.stringify(query), { flag: "wx" });
  raw = execFileSync(process.env.CF_EXECUTABLE ?? "cf", ["o11y", "telemetry", "query", "--body", `@${queryPath}`], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
} finally {
  await unlink(queryPath).catch(() => {});
}
const payload: unknown = JSON.parse(raw);
const parsed = z.object({ events: z.object({ events: z.array(z.object({
  $workers: z.object({ cpuTimeMs: z.number().optional(), wallTimeMs: z.number().optional(),
    outcome: z.string().optional(), scriptVersion: z.object({ id: z.string() }).optional(),
    event: z.object({ request: z.object({ url: z.string() }), response: z.object({ status: z.number() }).optional() }).optional(),
  }),
})) }) }).parse(payload);
if (parsed.events.events.length >= TELEMETRY_LIMIT) throw new Error("Telemetry response reached the 1000 event limit and may be truncated; report unchanged.");
const invocations = parsed.events.events.flatMap(({ $workers: event }) => {
  if (event.cpuTimeMs === undefined || !event.event) return [];
  const label = new URL(event.event.request.url).searchParams.get("case");
  if (!label?.startsWith(`${phase}-${runId}-`)) return [];
  return [{ label, cpuTimeMs: event.cpuTimeMs, wallTimeMs: event.wallTimeMs, outcome: event.outcome,
    status: event.event.response?.status, version: event.scriptVersion?.id }];
});
const report: ProfileReport = { runId, measurementStartedAt, measurementEndedAt, recordedAt: new Date().toISOString(), origin, worker, phase,
  method: "Cloudflare invocation cpuTimeMs; wallTimeMs is separate. Logs may arrive late. Rerun --events-only to retrieve them without traffic.",
  samples: previousReport?.samples ?? samples, invocations };
const saved = await publishReport(output, report, previousContents, values["events-only"] ?? false);
console.log(`Saved ${saved.samples.length} client results and ${saved.invocations.length} invocation records to ${output}.`);
