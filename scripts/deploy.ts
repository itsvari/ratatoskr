import { type Dirent, type Stats, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DEPLOYMENT_CONFIGURATION_PATH, run } from "./cloudflare.ts";
import { readDeploymentTarget, validateGeneratedTarget } from "./deployment-configuration.ts";

const configurationPath = resolve(DEPLOYMENT_CONFIGURATION_PATH);
const target = readDeploymentTarget(configurationPath);
const identifier = crypto.randomUUID();
const snapshot = resolve(dirname(configurationPath), `.ratatoskr-deploy-${identifier}.json`);
// the retained-output root belongs to the checkout that holds the deployment configuration, never to the working directory.
const retainedBuildDirectory = resolve(dirname(configurationPath), ".wrangler");
const retainedDeploymentsDirectory = resolve(retainedBuildDirectory, "deployments");
const output = resolve(retainedDeploymentsDirectory, identifier, "dist");
const generated = resolve(output, "worker/wrangler.json");
const environment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.account_id,
  RATATOSKR_CONFIG: snapshot, RATATOSKR_BUILD_DIRECTORY: output };
// the Vite build copies .dev.vars next to the generated Worker configuration, and this output is kept for rollback.
// a deployment must not leave a readable copy of local-only values on disk.
const localVariableFilePattern = /^(?:\.dev\.vars|\.env)(?:\..+)?$/;
// the sweep may only touch directories this script created, so a name that crypto.randomUUID cannot produce is never entered.
const generatedDeploymentIdentifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const missingDirectoryErrorCodes: readonly unknown[] = ["ENOENT", "ENOTDIR"];
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && missingDirectoryErrorCodes.includes(error.code);
}
// a retained deployment may be incomplete or already gone, which leaves nothing to remove.
function readDirectoryEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}
// lstat does not follow links, so a symlink to a directory is not a real directory.
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}
// a concurrent deployment removes its own failed output, so a path seen a moment ago can be gone by the time it is resolved.
function resolveRealPathIfPresent(path: string): string | null {
  try {
    return realpathSync(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}
// the sweep and the new output must stay inside this checkout. a link at either level would aim them at another checkout, whose
// retained .dev.vars files would be deleted, so deployment is refused instead of following it. lstat reports a Windows junction
// as a symbolic link, so junctions are refused too. an absent level has nothing to sweep, and mkdir later creates a real directory.
function assertRetainedOutputRootIsOwned(): void {
  for (const path of [retainedBuildDirectory, retainedDeploymentsDirectory]) {
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    if (!stats.isDirectory()) {
      throw new Error(`${path} must be a real directory inside this checkout, not a symbolic link, junction or file. Remove it or replace it with a real directory before deploying.`);
    }
  }
}
function isInside(parentDirectory: string, path: string): boolean {
  const relativePath = relative(parentDirectory, path);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}
// removing a symlink removes the link and never its target, which may belong to another checkout.
function removeLocalVariableFiles(workerDirectory: string): void {
  for (const entry of readDirectoryEntries(workerDirectory)) {
    if (localVariableFilePattern.test(entry.name) && (entry.isFile() || entry.isSymbolicLink())) rmSync(resolve(workerDirectory, entry.name), { force: true });
  }
}
// earlier deployments were retained for rollback before the removal above existed, so their outputs may still hold the copies.
// every component must be a real directory and the resolved Worker directory must stay inside the retained root, so a link planted
// in a retained output cannot redirect the sweep to files of another checkout.
function removeLocalVariableFilesFromRetainedDeployments(): void {
  const retainedRoot = resolveRealPathIfPresent(retainedDeploymentsDirectory);
  if (retainedRoot === null) return;
  for (const deployment of readDirectoryEntries(retainedDeploymentsDirectory)) {
    if (!generatedDeploymentIdentifierPattern.test(deployment.name)) continue;
    const deploymentDirectory = resolve(retainedDeploymentsDirectory, deployment.name);
    const distributionDirectory = resolve(deploymentDirectory, "dist");
    const workerDirectory = resolve(distributionDirectory, "worker");
    if (![deploymentDirectory, distributionDirectory, workerDirectory].every(isRealDirectory)) continue;
    const resolvedWorkerDirectory = resolveRealPathIfPresent(workerDirectory);
    if (resolvedWorkerDirectory === null || !isInside(retainedRoot, resolvedWorkerDirectory)) continue;
    removeLocalVariableFiles(workerDirectory);
  }
}
assertRetainedOutputRootIsOwned();
let publicationAttempted = false;
try {
  writeFileSync(snapshot, `${JSON.stringify(target, null, 2)}\n`, { flag: "wx" });
  removeLocalVariableFilesFromRetainedDeployments();
  mkdirSync(output, { recursive: true });
  run("bun", ["run", "build"], environment);
  validateGeneratedTarget(generated, target, output);
  removeLocalVariableFiles(dirname(generated));
  run(process.env.CF_EXECUTABLE ?? "cf", ["d1", "migrations", "apply", target.d1_databases[0].database_id,
    "--dir", resolve(dirname(configurationPath), target.d1_databases[0].migrations_dir)], environment);
  publicationAttempted = true;
  console.info(`Deployment configuration for rollback: ${generated}`);
  run("bun", ["x", "wrangler", "deploy", "--config", generated], environment);
  run("node", ["scripts/verify-deployment.ts"], environment);
} finally {
  rmSync(snapshot, { force: true });
  if (!publicationAttempted) rmSync(dirname(output), { recursive: true, force: true });
}
