import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

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
const samples: { readonly kind: string; readonly sequence: number; readonly status: number; readonly bytes: number }[] = [];
async function request(index: number, kind: string, method = "GET") {
  const sequence = samples.length;
  const response = await fetch(`${origin}/_preview/sample-${index}.png?case=${phase}-${kind}-${sequence}`, { method });
  const bytes = await response.arrayBuffer();
  samples.push({ kind, sequence, status: response.status, bytes: bytes.byteLength });
}
if (!values["events-only"]) {
  await request(0, "first");
  for (let index = 0; index < 20; index += 1) await request(0, "repeat");
  for (let index = 1; index <= 30; index += 1) await request(index, "varied");
  for (let index = 0; index < 10; index += 1) await request(index, "head", "HEAD");
  await Promise.all(Array.from({ length: 8 }, (_, index) => request(index + 31, "concurrent")));
  await request(0, "revisit");
}
const query = { queryId: "preview-performance", view: "events", limit: 1000,
  timeframe: { from: startedAt - 60 * 60 * 1000, to: Date.now() },
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
  return [{ label, cpuMs: event.cpuTimeMs, wallMs: event.wallTimeMs, outcome: event.outcome,
    status: event.event.response?.status, version: event.scriptVersion?.id }];
});
await writeFile(values.output!, JSON.stringify({ recordedAt: new Date().toISOString(), origin, worker, phase,
  method: "Cloudflare invocation cpuTimeMs; wallTimeMs is separate. Logs may arrive late. Rerun --events-only to retrieve them without traffic.",
  samples, invocations }, null, 2));
console.log(`Saved ${samples.length} client results and ${invocations.length} invocation records to ${values.output}.`);
