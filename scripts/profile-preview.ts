import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, type V4ModuleDefinition } from "miniflare";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod";

const { values } = parseArgs({ options: {
  runs: { type: "string", default: "3" }, samples: { type: "string", default: "30" },
  name: { type: "string", default: "Ratatoskr" }, title: { type: "string", default: "Design notes & useful links" },
  output: { type: "string", default: "verification-artifacts/preview-profile.json" },
} });
const runs = z.coerce.number().int().min(1).max(10).parse(values.runs);
const sampleCount = z.coerce.number().int().min(2).max(100).parse(values.samples);
if (process.platform !== "linux") throw new Error("This profiler requires Linux /proc task schedstat CPU accounting.");

const binaries = new Map<string, string>();
const bundle = await build({
  entryPoints: ["profiling/preview-worker.ts"], bundle: true, format: "esm", platform: "browser", write: false,
  external: ["node:*"], plugins: [{ name: "profile-worker-modules", setup(builder) {
    builder.onResolve({ filter: /\.(wasm|bin)$/ }, (argument) => {
      const path = argument.path.startsWith("@") ? resolve("node_modules", argument.path) : resolve(argument.resolveDir, argument.path);
      const name = basename(path);
      if (binaries.has(name) && binaries.get(name) !== path) throw new Error("Duplicate binary module name.");
      binaries.set(name, path);
      return { path: `./${name}`, external: true };
    });
    // Diagnostic instrumentation stays in this benchmark bundle, never the deployed Worker.
    builder.onLoad({ filter: /resvg-wasm\/index\.mjs$/ }, async (argument) => ({
      contents: `${await readFile(argument.path, "utf8")}\nglobalThis.__previewWasmBytes = () => wasm.memory.buffer.byteLength;`,
      loader: "js",
    }));
  } }],
});
const javascript = bundle.outputFiles[0];
if (!javascript) throw new Error("No profiling Worker was built.");
const modules: V4ModuleDefinition[] = [{ type: "ESModule", path: "/profile/index.js", contents: javascript.text }];
for (const [name, path] of binaries) modules.push({
  type: name.endsWith(".wasm") ? "CompiledWasm" : "Data", path: `/profile/${name}`, contents: await readFile(path),
});

async function runtimePid(): Promise<string> {
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const command = await readFile(`/proc/${name}/cmdline`, "utf8");
      if (parent === process.pid && command.includes("workerd") && command.includes("serve")) return name;
    } catch { /* A process may exit during enumeration. */ }
  }
  throw new Error("Cannot locate the profiling workerd child process.");
}

async function cpuMilliseconds(pid: string): Promise<number> {
  const stat = await readFile(`/proc/${pid}/task/${pid}/schedstat`, "utf8");
  return Number(BigInt(stat.split(" ")[0]!)) / 1_000_000;
}

async function sample(url: URL, pid: string) {
  const before = await cpuMilliseconds(pid);
  const start = performance.now();
  const response = await fetch(url);
  const bytes = await response.arrayBuffer();
  const wallMs = performance.now() - start;
  const cpuMs = await cpuMilliseconds(pid) - before;
  if (response.status !== 200) throw new Error(`Profiling response: ${response.status}`);
  return { cpuMs, wallMs, bytes: bytes.byteLength };
}

function summary(samples: readonly { cpuMs: number; wallMs: number; bytes: number }[]) {
  const cpu = samples.map((sample) => sample.cpuMs).sort((a, b) => a - b);
  return { medianCpuMs: cpu[Math.floor(cpu.length / 2)], p95CpuMs: cpu[Math.ceil(cpu.length * 0.95) - 1],
    maximumCpuMs: cpu.at(-1), meanCpuMs: cpu.reduce((total, value) => total + value, 0) / cpu.length, samples };
}

const targetSchema = z.array(z.object({ id: z.string(), webSocketDebuggerUrl: z.url() }));
async function heapUsage(inspector: URL): Promise<unknown> {
  const targets = targetSchema.parse(await (await fetch(`http://${inspector.host}/json/list`)).json());
  const target = targets.find((target) => target.id.startsWith("core:user:"));
  if (!target) throw new Error("No user Worker inspector target found.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  try {
    return await new Promise<unknown>((resolve, reject) => {
      socket.onmessage = (event) => {
        const message: unknown = JSON.parse(String(event.data));
        const parsed = z.object({ id: z.literal(1), result: z.unknown().optional(), error: z.unknown().optional() }).safeParse(message);
        if (!parsed.success) return;
        if (parsed.data.error) reject(parsed.data.error);
        else resolve(parsed.data.result);
      };
      socket.send(JSON.stringify({ id: 1, method: "Runtime.getHeapUsage" }));
    });
  } finally { socket.close(); }
}

const results = [];
for (let run = 0; run < runs; run += 1) {
  const miniflare = new Miniflare({ ...convertV4MiniflareOptions({
    modulesRoot: "/profile", modules, compatibilityDate: "2026-10-06", compatibilityFlags: ["nodejs_compat"],
    inspectorPort: 0, unsafeDirectSockets: [{ host: "127.0.0.1", port: 0 }],
  }), telemetry: { enabled: false } });
  try {
    const startup = performance.now();
    await miniflare.ready;
    const startupWallMs = performance.now() - startup;
    const pid = await runtimePid();
    const origin = await miniflare.unsafeGetDirectURL();
    const url = new URL("/image", origin);
    url.searchParams.set("name", values.name!);
    url.searchParams.set("title", values.title!);
    const cold = await sample(url, pid);
    const hits = [];
    for (let index = 0; index < sampleCount; index += 1) hits.push(await sample(url, pid));
    const misses = [];
    for (let index = 0; index < sampleCount; index += 1) {
      url.searchParams.set("title", `${values.title} ${index}`);
      misses.push(await sample(url, pid));
    }
    const memory: unknown = await (await fetch(new URL("/memory", origin))).json();
    const heap = await heapUsage(await miniflare.getInspectorURL());
    const result = { run, startupWallMs, cold, hits: summary(hits), misses: summary(misses), memory, heap };
    results.push(result);
    console.log(JSON.stringify({ ...result, hits: { ...result.hits, samples: undefined }, misses: { ...result.misses, samples: undefined } }));
  } finally { await miniflare.dispose(); }
}
await mkdir(dirname(values.output!), { recursive: true });
await writeFile(values.output!, JSON.stringify({
  method: "Local workerd main-thread Linux schedstat CPU deltas around direct HTTP requests; includes runtime overhead, excludes D1/routing and background compiler threads. Not production billing evidence.",
  recordedAt: new Date().toISOString(), node: process.versions.node, cpu: cpus()[0]?.model,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workerd: JSON.parse(await readFile("node_modules/workerd/package.json", "utf8")).version as unknown,
  name: values.name, title: values.title, results,
}, null, 2));
