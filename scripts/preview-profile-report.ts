import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { z } from "zod";

const sampleSchema = z.object({ kind: z.string(), sequence: z.number(), status: z.number(), bytes: z.number(),
  isolate: z.string().nullable(), isolateSequence: z.string().nullable() });
const invocationSchema = z.object({ label: z.string(), cpuTimeMs: z.number(), wallTimeMs: z.number().optional(),
  outcome: z.string().optional(), status: z.number().optional(), version: z.string().optional() });
export const reportSchema = z.object({ runId: z.uuid(), measurementStartedAt: z.iso.datetime(), measurementEndedAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(), origin: z.string(), worker: z.string(), phase: z.string(), method: z.string(),
  samples: z.array(sampleSchema), invocations: z.array(invocationSchema) });
export type ProfileReport = z.infer<typeof reportSchema>;
export type Invocation = z.infer<typeof invocationSchema>;

export async function readReport(path: string): Promise<{ report: ProfileReport; contents: string }> {
  const contents = await readFile(path, "utf8");
  const value: unknown = JSON.parse(contents);
  if (typeof value === "object" && value !== null && !("runId" in value)) {
    throw new Error("Legacy profiling report lacks a run UUID; its events cannot be refreshed safely.");
  }
  const report = reportSchema.parse(value);
  if (Date.parse(report.measurementStartedAt) > Date.parse(report.measurementEndedAt)) throw new Error("Invalid measurement interval.");
  return { report, contents };
}

export function checkIdentity(report: ProfileReport, identity: Pick<ProfileReport, "origin" | "worker" | "phase" | "runId">): void {
  if (report.origin !== identity.origin || report.worker !== identity.worker || report.phase !== identity.phase || report.runId !== identity.runId) {
    throw new Error("Profiling report identity does not match the requested run.");
  }
}

export async function publishReport(path: string, report: ProfileReport, previousContents: string | null, refresh: boolean): Promise<ProfileReport> {
  try {
    return await publishLockedReport(path, report, previousContents, refresh);
  } catch (error: unknown) {
    if (refresh) throw error;
    const recoveryPath = `${path}.${report.runId}.${randomUUID()}.recovery.json`;
    try {
      await writeFile(recoveryPath, JSON.stringify(reportSchema.parse(report), null, 2), { flag: "wx" });
    } catch (recoveryError: unknown) {
      throw new AggregateError([error, recoveryError], `Profiling report publication failed: ${String(error)}. Recovery could not be saved at ${recoveryPath}: ${String(recoveryError)}.`, { cause: error });
    }
    throw new Error(`Profiling report publication failed: ${String(error)}. Recovery saved at ${recoveryPath}. Retry events with --events-only --output ${recoveryPath}.`, { cause: error });
  }
}

async function publishLockedReport(path: string, report: ProfileReport, previousContents: string | null, refresh: boolean): Promise<ProfileReport> {
  const lockPath = `${path}.lock`;
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const lock = await open(lockPath, "wx").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error(`Profiling report lock already exists: ${lockPath}`, { cause: error });
    throw error;
  });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), runId: report.runId, startedAt: new Date().toISOString() }));
    let currentContents: string | null;
    try { currentContents = await readFile(path, "utf8"); } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      currentContents = null;
    }
    let result = report;
    if (refresh) {
      if (currentContents === null) throw new Error("Profiling report disappeared during refresh.");
      const current = (await readReport(path)).report;
      checkIdentity(current, report);
      if (current.measurementStartedAt !== report.measurementStartedAt || current.measurementEndedAt !== report.measurementEndedAt) {
        throw new Error("Profiling report measurement interval changed during refresh.");
      }
      const invocations = new Map(current.invocations.map((invocation) => [invocation.label, invocation]));
      for (const invocation of report.invocations) invocations.set(invocation.label, invocation);
      result = { ...current, recordedAt: report.recordedAt, invocations: [...invocations.values()].sort((left, right) => left.label.localeCompare(right.label)) };
    } else if (currentContents !== previousContents) {
      throw new Error("Profiling report changed during measurement; refusing to overwrite it.");
    }
    await writeFile(temporaryPath, JSON.stringify(result, null, 2), { flag: "wx" });
    await rename(temporaryPath, path);
    return result;
  } finally {
    const ownedLock = await lock.stat();
    await lock.close();
    await unlink(temporaryPath).catch(() => {});
    const currentLock = await stat(lockPath).catch(() => null);
    if (currentLock && currentLock.dev === ownedLock.dev && currentLock.ino === ownedLock.ino) await unlink(lockPath);
  }
}
