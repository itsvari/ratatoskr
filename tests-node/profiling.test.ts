import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { z } from "zod";
import { publishReport, reportSchema, type ProfileReport } from "../scripts/preview-profile-report.ts";

const execute = promisify(execFile);
const querySchema = z.object({ timeframe: z.object({ from: z.number(), to: z.number() }) });
const parseJson = (contents: string): unknown => JSON.parse(contents);
const origin = "https://ratatoskr-preview-cpu-test.example.workers.dev";
const worker = "ratatoskr-preview-cpu-test";
const runId = randomUUID();
const report: ProfileReport = { runId, origin, worker, phase: "stored", measurementStartedAt: "2020-01-01T00:00:00.000Z",
  measurementEndedAt: "2020-01-01T00:01:00.000Z", recordedAt: "2020-01-01T00:02:00.000Z", method: "test",
  samples: [{ kind: "first", sequence: 0, status: 200, bytes: 10, isolate: null, isolateSequence: null }],
  invocations: [{ label: `stored-${runId}-first-0`, cpuTimeMs: 1 }] };
const script = resolve("scripts/profile-preview-deployed.ts");
const fakeCli = resolve("tests-node/profiling-fake-cli.mjs");
const argumentsFor = (path: string, phase = "stored") => [script, "--origin", origin, "--worker", worker, "--phase", phase, "--output", path, "--events-only"];
const event = (label: string) => ({ $workers: { cpuTimeMs: 2, event: { request: { url: `${origin}/?case=${label}` } } } });

test("refresh preserves evidence, uses the original window, and filters other runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-test-"));
  try {
    const path = join(directory, "report.json");
    const response = join(directory, "response.json");
    const query = join(directory, "query.json");
    await writeFile(path, JSON.stringify(report));
    await writeFile(response, JSON.stringify({ events: { events: [] } }));
    const environment = { ...process.env, CF_EXECUTABLE: fakeCli, PROFILE_FAKE_RESPONSE: response, PROFILE_FAKE_QUERY: query };
    await execute(process.execPath, argumentsFor(path), { env: environment });
    let saved = reportSchema.parse(parseJson(await readFile(path, "utf8")));
    assert.deepEqual(saved.samples, report.samples);
    assert.deepEqual(saved.invocations, report.invocations);
    assert.deepEqual(querySchema.parse(parseJson(await readFile(query, "utf8"))).timeframe, { from: Date.parse(report.measurementStartedAt), to: Date.parse(report.measurementEndedAt) });
    const late = `stored-${runId}-repeat-1`;
    await writeFile(response, JSON.stringify({ events: { events: [event(late), event(late), event(`stored-${randomUUID()}-repeat-1`)] } }));
    await execute(process.execPath, argumentsFor(path), { env: environment });
    saved = reportSchema.parse(parseJson(await readFile(path, "utf8")));
    assert.equal(saved.invocations.length, 2);
    assert.deepEqual((await readdir(directory)).filter((name) => name.includes(".query.json")), []);
    const before = await readFile(path, "utf8");
    await assert.rejects(execute(process.execPath, argumentsFor(path, "other"), { env: environment }));
    await writeFile(response, JSON.stringify({ events: { events: Array.from({ length: 1000 }, () => event(late)) } }));
    await assert.rejects(execute(process.execPath, argumentsFor(path), { env: environment }), /may be truncated/);
    assert.equal(await readFile(path, "utf8"), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("locks prevent contention and stale lock takeover; failed publication cleans its lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-lock-"));
  try {
    const path = join(directory, "report.json");
    await writeFile(path, JSON.stringify(report));
    await writeFile(`${path}.lock`, "stale");
    await assert.rejects(publishReport(path, report, null, true), /lock already exists/);
    assert.equal(await readFile(`${path}.lock`, "utf8"), "stale");
    await rm(`${path}.lock`);
    await assert.rejects(publishReport(path, { ...report, runId: randomUUID() }, null, true), /identity/);
    assert.deepEqual(await readdir(directory), ["report.json"]);

  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("simultaneous refreshes retain both independently fetched event sets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-merge-"));
  try {
    const path = join(directory, "report.json");
    await writeFile(path, JSON.stringify(report));
    const first = { ...report, invocations: [{ label: `stored-${runId}-repeat-1`, cpuTimeMs: 1 }] };
    const second = { ...report, invocations: [{ label: `stored-${runId}-repeat-2`, cpuTimeMs: 2 }] };
    const candidates = [first, second];
    const results = await Promise.allSettled(candidates.map((candidate) => publishReport(path, candidate, null, true)));
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      assert.match(String(result.reason), /lock already exists/);
      const candidate = candidates[index];
      assert.ok(candidate);
      await publishReport(path, candidate, null, true);
    }
    const saved = reportSchema.parse(parseJson(await readFile(path, "utf8")));
    assert.deepEqual(saved.invocations.map((invocation) => invocation.label).sort(),
      [...report.invocations, ...first.invocations, ...second.invocations].map((invocation) => invocation.label).sort());
    assert.deepEqual(await readdir(directory), ["report.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new measurement rejects a changed report and publication errors release the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-publication-"));
  try {
    const path = join(directory, "report.json");
    const original = JSON.stringify(report);
    await writeFile(path, original);
    const newer = { ...report, runId: randomUUID() };
    const newerContents = JSON.stringify(newer);
    await writeFile(path, newerContents);
    await assert.rejects(publishReport(path, report, original, false), /changed during measurement/);
    assert.equal(await readFile(path, "utf8"), newerContents);
    const recoveryName = (await readdir(directory)).find((name) => name.endsWith(".recovery.json"));
    assert.ok(recoveryName);
    const recoveryPath = join(directory, recoveryName);
    assert.deepEqual(reportSchema.parse(parseJson(await readFile(recoveryPath, "utf8"))), report);
    const response = join(directory, "response.json");
    const query = join(directory, "query.json");
    const label = `stored-${runId}-repeat-3`;
    await writeFile(response, JSON.stringify({ events: { events: [event(label)] } }));
    await execute(process.execPath, argumentsFor(recoveryPath), { env: { ...process.env, CF_EXECUTABLE: fakeCli,
      PROFILE_FAKE_RESPONSE: response, PROFILE_FAKE_QUERY: query } });
    const refreshed = reportSchema.parse(parseJson(await readFile(recoveryPath, "utf8")));
    assert.ok(refreshed.invocations.some((invocation) => invocation.label === label));
    await assert.rejects(publishReport(directory, report, null, true));
    await assert.rejects(readFile(`${directory}.lock`), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("legacy and mismatched identities fail before querying", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-identity-"));
  try {
    const path = join(directory, "report.json");
    const response = join(directory, "response.json");
    const query = join(directory, "query.json");
    await writeFile(response, JSON.stringify({ events: { events: [] } }));
    const environment = { ...process.env, CF_EXECUTABLE: fakeCli, PROFILE_FAKE_RESPONSE: response, PROFILE_FAKE_QUERY: query };
    for (const changed of [{ ...report, worker: "ratatoskr-preview-cpu-other" }, { ...report, origin: "https://other.workers.dev" }]) {
      const contents = JSON.stringify(changed);
      await writeFile(path, contents);
      await assert.rejects(execute(process.execPath, argumentsFor(path), { env: environment }), /identity/);
      assert.equal(await readFile(path, "utf8"), contents);
    }
    const { runId: omitted, ...legacy } = report;
    assert.ok(omitted);
    await writeFile(path, JSON.stringify(legacy));
    await assert.rejects(execute(process.execPath, argumentsFor(path), { env: environment }), /Legacy profiling report/);
    await assert.rejects(readFile(query), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a busy new measurement is recoverable and can refresh events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-recovery-"));
  try {
    const path = join(directory, "report.json");
    const original = JSON.stringify(report);
    const newReport = { ...report, runId: randomUUID() };
    await writeFile(path, original);
    await writeFile(`${path}.lock`, "foreign lock");
    await assert.rejects(publishReport(path, newReport, original, false), /lock already exists.*recovery saved/i);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(await readFile(`${path}.lock`, "utf8"), "foreign lock");
    const recoveryName = (await readdir(directory)).find((name) => name.endsWith(".recovery.json"));
    assert.ok(recoveryName);
    const recoveryPath = join(directory, recoveryName);
    assert.deepEqual(reportSchema.parse(parseJson(await readFile(recoveryPath, "utf8"))), newReport);
    const response = join(directory, "response.json");
    const query = join(directory, "query.json");
    const label = `stored-${newReport.runId}-repeat-1`;
    await writeFile(response, JSON.stringify({ events: { events: [event(label)] } }));
    await execute(process.execPath, argumentsFor(recoveryPath), { env: { ...process.env, CF_EXECUTABLE: fakeCli,
      PROFILE_FAKE_RESPONSE: response, PROFILE_FAKE_QUERY: query } });
    const saved = reportSchema.parse(parseJson(await readFile(recoveryPath, "utf8")));
    assert.deepEqual(saved.samples, newReport.samples);
    assert.equal(saved.runId, newReport.runId);
    assert.equal(saved.measurementStartedAt, newReport.measurementStartedAt);
    assert.equal(saved.measurementEndedAt, newReport.measurementEndedAt);
    assert.ok(saved.invocations.some((invocation) => invocation.label === label));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed recovery reports both errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "profile-recovery-failure-"));
  try {
    const path = join(directory, "missing", "report.json");
    await assert.rejects(publishReport(path, report, null, false), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /publication failed.*recovery could not be saved/i);
      assert.equal(error.cause, error.errors[0]);
      return true;
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
