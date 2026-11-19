import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { readDeploymentTarget, validateGeneratedTarget } from "../scripts/deployment-configuration.ts";
import { classifyManagementAnswer, classifyStrictTransportSecurity, isUncachedResponse, WORKER_FORBIDDEN_ORIGIN_MESSAGE, WORKER_UNAUTHENTICATED_MESSAGE } from "../scripts/deployment-probes.ts";

const root = process.cwd();
const runtime = process.execPath;
function configuration(database: string) {
  return { name: "test-hyphen", workers_dev: false, preview_urls: false, account_id: "account", routes: [{ pattern: "example.com", custom_domain: true }], main: "src/index.ts", assets: { directory: "dist/client" },
    vars: { SHORT_ORIGIN: "https://example.com", ADMIN_ORIGIN: "https://example.com", PREVIEW_ORIGIN: "", ACCESS_ISSUER: "https://team.cloudflareaccess.com", ACCESS_AUDIENCE: "audience", ADMIN_EMAILS: "admin@example.com" },
    d1_databases: [{ binding: "DB", database_name: "test-hyphen", database_id: database, migrations_dir: "migrations" }] };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ratatoskr-operations-"));
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "bin"));
  for (const name of ["deploy.ts", "cloudflare.ts", "deployment-configuration.ts", "verify-deployment.ts", "verify-live-links.ts", "deployment-http.ts", "deployment-probes.ts"]) {
    copyFileSync(join(root, "scripts", name), join(directory, "scripts", name));
  }
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(directory, "wrangler.deploy.json"), JSON.stringify(configuration("database-a")));
  writeFileSync(join(directory, "deployment-state.json"), JSON.stringify({ databaseId: "stale-database" }));
  const fake = `#!${runtime}
import {appendFileSync,readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
const args=process.argv.slice(2), stage=process.argv[1].split('/').pop();
const record=(entry)=>appendFileSync('calls.jsonl',JSON.stringify(entry)+'\\n');
const target=JSON.parse(readFileSync(process.env.RATATOSKR_CONFIG,'utf8'));
if(stage==='bun' && args[0]==='run') {
  record({stage:'build', database:target.d1_databases[0].database_id, output:process.env.RATATOSKR_BUILD_DIRECTORY, snapshot:process.env.RATATOSKR_CONFIG});
  if(process.env.REPLACE_TARGET) writeFileSync('wrangler.deploy.json',process.env.REPLACE_TARGET);
  if(process.env.FAIL_STAGE==='build') process.exit(1);
  if(process.env.DELAY_BUILD) await new Promise(resolve=>setTimeout(resolve,150));
  const output=process.env.RATATOSKR_BUILD_DIRECTORY, path=join(output,'worker','wrangler.json');
  mkdirSync(dirname(path),{recursive:true});
  target.main='index.js';target.assets.directory='../client';
  if(process.env.FAIL_STAGE==='invalid') target.d1_databases[0].database_id='wrong';
  if(process.env.FAIL_STAGE==='route') target.routes[0].pattern='wrong.example.com';
  writeFileSync(path,JSON.stringify(target));
  if(process.env.WRITE_LOCAL_VARIABLES) for(const name of ['.dev.vars','.dev.vars.staging','.env','.env.local','.environment.json']) writeFileSync(join(dirname(path),name),'SECRET=value');
} else if(stage==='cf') {
  const workerDirectory=join(process.env.RATATOSKR_BUILD_DIRECTORY,'worker');
  record({stage:'migrate',database:args[3],account:process.env.CLOUDFLARE_ACCOUNT_ID,workerFiles:readdirSync(workerDirectory).sort().join(',')});
  if(process.env.FAIL_STAGE==='migrate') process.exit(1);
} else if(stage==='bun') {
  record({stage:'publish',path:args[args.length-1],database:JSON.parse(readFileSync(args[args.length-1],'utf8')).d1_databases[0].database_id});
  if(process.env.FAIL_STAGE==='publish') process.exit(1);
} else {
  record({stage:'verify',database:target.d1_databases[0].database_id,snapshot:process.env.RATATOSKR_CONFIG});
  if(process.env.FAIL_STAGE==='verify') process.exit(1);
}`;
  for (const command of ["bun", "cf", "node"]) {
    const path = join(directory, "bin", command);
    writeFileSync(path, fake);
    chmodSync(path, 0o755);
  }
  return directory;
}
function environment(directory: string, extra: Record<string, string> = {}) {
  return { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, CF_EXECUTABLE: join(directory, "bin", "cf"), ...extra };
}
function calls(directory: string): Array<Record<string, string>> {
  try {
    return readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map((line) => {
      const value: unknown = JSON.parse(line);
      return z.record(z.string(), z.string()).parse(value);
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
function deploy(directory: string, extra: Record<string, string> = {}) {
  return spawnSync(runtime, ["scripts/deploy.ts"], { cwd: directory, env: environment(directory, extra), encoding: "utf8" });
}
test("captured target survives replacement and stale inventory", () => {
  const directory = fixture();
  try {
    const result = deploy(directory, { REPLACE_TARGET: JSON.stringify(configuration("database-b")) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(directory).map((entry) => [entry.stage, entry.database]), [["build", "database-a"], ["migrate", "database-a"], ["publish", "database-a"], ["verify", "database-a"]]);
    const entries = calls(directory);
    assert.equal(entries[0]?.snapshot, entries[3]?.snapshot);
    assert.equal(readDeploymentTarget(join(directory, "wrangler.deploy.json")).d1_databases[0].database_id, "database-b");
    assert.throws(() => readFileSync(entries[0]!.snapshot!));
    assert.ok(readFileSync(entries[2]!.path!));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("failed stages stop later operations and retain only possibly published output", () => {
  const failureMessages = {
    build: /Command failed: bun run build/, invalid: /differs from the captured configuration/, route: /differs from the captured configuration/,
    migrate: /Command failed: .*cf d1 migrations apply/, publish: /Command failed: bun x wrangler deploy/, verify: /Command failed: node scripts\/verify-deployment\.ts/,
  } as const;
  for (const [failure, expected] of [["build", ["build"]], ["invalid", ["build"]], ["route", ["build"]], ["migrate", ["build", "migrate"]], ["publish", ["build", "migrate", "publish"]], ["verify", ["build", "migrate", "publish", "verify"]]] as const) {
    const directory = fixture();
    try {
      const result = deploy(directory, { FAIL_STAGE: failure });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, failureMessages[failure], failure);
      const entries = calls(directory);
      assert.deepEqual(entries.map((entry) => entry.stage), expected);
      assert.throws(() => readFileSync(entries[0]!.snapshot!));
      if (failure === "publish" || failure === "verify") assert.ok(readFileSync(entries[2]!.path!));
      else assert.throws(() => readFileSync(join(entries[0]!.output!, "worker", "wrangler.json")));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
test("local-only variable files are removed from the generated Worker before migration while the rollback configuration remains", () => {
  const directory = fixture();
  try {
    const result = deploy(directory, { WRITE_LOCAL_VARIABLES: "1" });
    assert.equal(result.status, 0, result.stderr);
    const entries = calls(directory);
    const migration = entries.find((entry) => entry.stage === "migrate");
    // a similarly named file that is not a local variable file proves the removal is not over-broad.
    assert.equal(migration?.workerFiles, ".environment.json,wrangler.json");
    const workerDirectory = join(entries[0]!.output!, "worker");
    for (const name of [".dev.vars", ".dev.vars.staging", ".env", ".env.local"]) {
      assert.equal(existsSync(join(workerDirectory, name)), false, name);
    }
    assert.ok(readFileSync(join(workerDirectory, "wrangler.json")));
    assert.ok(readFileSync(join(workerDirectory, ".environment.json")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
const ORDINARY_DEPLOYMENT = "11111111-1111-4111-8111-111111111111";
const SYMLINKED_DISTRIBUTION_DEPLOYMENT = "22222222-2222-4222-8222-222222222222";
const SYMLINKED_WORKER_DEPLOYMENT = "33333333-3333-4333-8333-333333333333";
const SYMLINKED_DEPLOYMENT = "44444444-4444-4444-8444-444444444444";
const LOCAL_VARIABLE_FILE_NAMES = [".dev.vars", ".dev.vars.staging", ".env", ".env.local"];
test("local-only variable files are swept from the Worker output of earlier retained deployments", () => {
  const directory = fixture();
  try {
    const retained = join(directory, ".wrangler", "deployments");
    const olderWorker = join(retained, ORDINARY_DEPLOYMENT, "dist", "worker");
    mkdirSync(olderWorker, { recursive: true });
    for (const name of [...LOCAL_VARIABLE_FILE_NAMES, ".environment.json", "wrangler.json"]) writeFileSync(join(olderWorker, name), "SECRET=value");
    // a link inside the Worker output is removed as a link, and what it points at survives.
    const outsideTarget = join(directory, "outside-target.txt");
    writeFileSync(outsideTarget, "kept");
    rmSync(join(olderWorker, ".env.local"));
    symlinkSync(outsideTarget, join(olderWorker, ".env.local"));
    // a directory that merely has a local-variable name is not a file and stays.
    mkdirSync(join(olderWorker, ".env.d"));
    writeFileSync(join(olderWorker, ".env.d", "kept.txt"), "kept");
    // files outside dist/worker, and entries that are not deployment directories or lack a Worker output, must survive.
    mkdirSync(join(retained, ORDINARY_DEPLOYMENT, "dist", "client"), { recursive: true });
    writeFileSync(join(retained, ORDINARY_DEPLOYMENT, "dist", "client", ".env"), "kept");
    writeFileSync(join(retained, ORDINARY_DEPLOYMENT, ".dev.vars"), "kept");
    mkdirSync(join(retained, "55555555-5555-4555-8555-555555555555"), { recursive: true });
    writeFileSync(join(retained, "stray-file"), "kept");
    // a directory whose name deploy.ts could not have generated is left alone even when it has the expected layout.
    const nonGeneratedWorker = join(retained, "older", "dist", "worker");
    mkdirSync(nonGeneratedWorker, { recursive: true });
    writeFileSync(join(nonGeneratedWorker, ".dev.vars"), "kept");
    const result = deploy(directory);
    assert.equal(result.status, 0, result.stderr);
    for (const name of LOCAL_VARIABLE_FILE_NAMES) assert.equal(existsSync(join(olderWorker, name)), false, name);
    assert.equal(readFileSync(outsideTarget, "utf8"), "kept");
    assert.equal(readFileSync(join(olderWorker, ".env.d", "kept.txt"), "utf8"), "kept");
    for (const name of [".environment.json", "wrangler.json"]) assert.equal(readFileSync(join(olderWorker, name), "utf8"), "SECRET=value", name);
    assert.equal(readFileSync(join(retained, ORDINARY_DEPLOYMENT, "dist", "client", ".env"), "utf8"), "kept");
    assert.equal(readFileSync(join(retained, ORDINARY_DEPLOYMENT, ".dev.vars"), "utf8"), "kept");
    assert.equal(readFileSync(join(retained, "stray-file"), "utf8"), "kept");
    assert.equal(readFileSync(join(nonGeneratedWorker, ".dev.vars"), "utf8"), "kept");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("the retained-output sweep never follows a symlinked deployment, dist or worker directory out of the retained root", () => {
  const directory = fixture();
  try {
    const retained = join(directory, ".wrangler", "deployments");
    mkdirSync(retained, { recursive: true });
    // each outside tree stands for another checkout whose matching files must survive.
    const outside = join(directory, "another-checkout");
    const outsideWorker = join(outside, "worker");
    mkdirSync(outsideWorker, { recursive: true });
    for (const name of LOCAL_VARIABLE_FILE_NAMES) writeFileSync(join(outsideWorker, name), "SECRET=value");
    const outsideDeployment = join(outside, "deployment");
    mkdirSync(join(outsideDeployment, "dist", "worker"), { recursive: true });
    writeFileSync(join(outsideDeployment, "dist", "worker", ".dev.vars"), "SECRET=value");
    mkdirSync(join(retained, SYMLINKED_DISTRIBUTION_DEPLOYMENT));
    symlinkSync(outside, join(retained, SYMLINKED_DISTRIBUTION_DEPLOYMENT, "dist"));
    mkdirSync(join(retained, SYMLINKED_WORKER_DEPLOYMENT, "dist"), { recursive: true });
    symlinkSync(outsideWorker, join(retained, SYMLINKED_WORKER_DEPLOYMENT, "dist", "worker"));
    symlinkSync(outsideDeployment, join(retained, SYMLINKED_DEPLOYMENT));
    const result = deploy(directory);
    assert.equal(result.status, 0, result.stderr);
    for (const name of LOCAL_VARIABLE_FILE_NAMES) assert.equal(readFileSync(join(outsideWorker, name), "utf8"), "SECRET=value", name);
    assert.equal(readFileSync(join(outsideDeployment, "dist", "worker", ".dev.vars"), "utf8"), "SECRET=value");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
const OUTSIDE_RETAINED_DEPLOYMENT = "66666666-6666-4666-8666-666666666666";
// another checkout whose retained output holds a local-only variable file that must never be touched.
function outsideCheckoutWithRetainedSecret(directory: string): { readonly root: string; readonly secret: string; readonly deployments: string } {
  const root = join(directory, "another-checkout");
  const deployments = join(root, ".wrangler", "deployments");
  const worker = join(deployments, OUTSIDE_RETAINED_DEPLOYMENT, "dist", "worker");
  mkdirSync(worker, { recursive: true });
  const secret = join(worker, ".dev.vars");
  writeFileSync(secret, "SECRET=value");
  return { root, secret, deployments };
}
function assertDeploymentRefused(directory: string, outside: { readonly secret: string; readonly deployments: string }, label: string): void {
  const result = deploy(directory);
  assert.notEqual(result.status, 0, label);
  assert.match(result.stderr, /must be a real directory inside this checkout/, label);
  assert.equal(readFileSync(outside.secret, "utf8"), "SECRET=value", label);
  assert.deepEqual(readdirSync(outside.deployments), [OUTSIDE_RETAINED_DEPLOYMENT], `${label}: no output may be created through the link`);
  assert.deepEqual(calls(directory), [], `${label}: no build, migration or publication may start`);
  assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith(".ratatoskr-deploy-")), [], `${label}: no snapshot may remain`);
}
test("a symlinked .wrangler or .wrangler/deployments refuses deployment and leaves the other checkout's local variables intact", () => {
  const directory = fixture();
  try {
    const outside = outsideCheckoutWithRetainedSecret(directory);
    symlinkSync(join(outside.root, ".wrangler"), join(directory, ".wrangler"));
    assertDeploymentRefused(directory, outside, "symlinked .wrangler");
    rmSync(join(directory, ".wrangler"));
    mkdirSync(join(directory, ".wrangler"));
    symlinkSync(outside.deployments, join(directory, ".wrangler", "deployments"));
    assertDeploymentRefused(directory, outside, "symlinked deployments");
    rmSync(join(directory, ".wrangler", "deployments"));
    // a file in place of either level is not a directory the sweep or the build can use.
    rmSync(join(directory, ".wrangler"), { recursive: true });
    writeFileSync(join(directory, ".wrangler"), "not a directory");
    assertDeploymentRefused(directory, outside, ".wrangler as a file");
    // the same checkout deploys once the links are gone, and creates real directories for the new output.
    rmSync(join(directory, ".wrangler"));
    const result = deploy(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lstatSync(join(directory, ".wrangler")).isDirectory(), true);
    assert.equal(lstatSync(join(directory, ".wrangler", "deployments")).isDirectory(), true);
    assert.equal(readFileSync(outside.secret, "utf8"), "SECRET=value");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
// removes the deployment directory right after its Worker directory passed the lstat check, as a concurrent deployment that
// deletes its failed output would.
const VANISHING_DEPLOYMENT_PRELOAD = `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const originalLstat=fs.lstatSync;
const vanishingWorkerSuffix='/'+process.env.VANISHING_DEPLOYMENT+'/dist/worker';
fs.lstatSync=(path,...rest)=>{
  const stats=originalLstat(path,...rest);
  if(String(path).endsWith(vanishingWorkerSuffix)) fs.rmSync(String(path).slice(0,-'/dist/worker'.length),{recursive:true,force:true});
  return stats;
};
syncBuiltinESMExports();`;
test("a retained deployment that disappears during the sweep is skipped", () => {
  const directory = fixture();
  try {
    const retained = join(directory, ".wrangler", "deployments");
    const survivingWorker = join(retained, ORDINARY_DEPLOYMENT, "dist", "worker");
    const vanishingWorker = join(retained, SYMLINKED_WORKER_DEPLOYMENT, "dist", "worker");
    for (const worker of [survivingWorker, vanishingWorker]) {
      mkdirSync(worker, { recursive: true });
      writeFileSync(join(worker, ".dev.vars"), "SECRET=value");
    }
    writeFileSync(join(directory, "vanish.mjs"), VANISHING_DEPLOYMENT_PRELOAD);
    const result = spawnSync(runtime, ["--import", "./vanish.mjs", "scripts/deploy.ts"], {
      cwd: directory, env: environment(directory, { VANISHING_DEPLOYMENT: SYMLINKED_WORKER_DEPLOYMENT }), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(retained, SYMLINKED_WORKER_DEPLOYMENT)), false, "the injected removal must have happened");
    assert.equal(existsSync(join(survivingWorker, ".dev.vars")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("simultaneous deployments own separate outputs and snapshots", async () => {
  const directory = fixture();
  try {
    const run = () => new Promise<number | null>((done) => {
      const child = spawn(runtime, ["scripts/deploy.ts"], { cwd: directory, env: environment(directory, { DELAY_BUILD: "1" }), stdio: "ignore" });
      child.on("exit", done);
    });
    assert.deepEqual(await Promise.all([run(), run()]), [0, 0]);
    const builds = calls(directory).filter((entry) => entry.stage === "build");
    assert.equal(new Set(builds.map((entry) => entry.output)).size, 2);
    assert.equal(new Set(builds.map((entry) => entry.snapshot)).size, 2);
    assert.equal(new Set(calls(directory).filter((entry) => entry.stage === "publish").map((entry) => entry.path)).size, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("real Vite build supports hyphenated names with contained paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "ratatoskr-vite-"));
  try {
    for (const name of ["admin", "src", "shared", "scripts"]) cpSync(join(root, name), join(directory, name), { recursive: true });
    for (const name of ["package.json", "vite.config.ts", "wrangler.jsonc"]) copyFileSync(join(root, name), join(directory, name));
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
    const base: unknown = JSON.parse(readFileSync(join(directory, "wrangler.jsonc"), "utf8"));
    assert.ok(typeof base === "object" && base !== null);
    const target = { ...base, ...configuration("database-a") };
    const snapshot = join(directory, ".ratatoskr-deploy-test.json");
    const output = join(directory, ".wrangler", "deployments", "test", "dist");
    writeFileSync(snapshot, JSON.stringify(target));
    const build = spawnSync("bun", ["run", "build"], { cwd: directory, env: { ...process.env, RATATOSKR_CONFIG: snapshot, RATATOSKR_BUILD_DIRECTORY: output }, encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    validateGeneratedTarget(resolve(output, "worker/wrangler.json"), readDeploymentTarget(snapshot), output);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("an interrupted atomic replacement leaves the previous target readable", () => {
  const directory = fixture();
  try {
    const injector = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
fs.renameSync=()=>{throw new Error('interrupted replacement')};syncBuiltinESMExports();
const {atomicWrite}=await import('./scripts/deployment-configuration.ts');
try {atomicWrite('wrangler.deploy.json', ${JSON.stringify(JSON.stringify(configuration("database-b")))});} catch {}`;
    writeFileSync(join(directory, "interrupt.mjs"), injector);
    const result = spawnSync(runtime, ["interrupt.mjs"], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readDeploymentTarget(join(directory, "wrangler.deploy.json")).d1_databases[0].database_id, "database-a");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
// the fake fetch answers every probe as a correctly configured deployment; scenarios override single URLs.
const VERIFICATION_PRELOAD = `import {appendFileSync} from 'node:fs';
const overrides=JSON.parse(process.env.FIXTURE_OVERRIDES??'{}');
const accessLogin={status:302,login:'?kid=audience&redirect_url=%2Fapi%2Flinks'};
const healthy={status:200,headers:{'Strict-Transport-Security':'max-age=31536000; includeSubDomains'},body:'{"status":"ok"}'};
const upgrade=(host)=>({status:308,headers:{Location:'https://'+host+'/_health?verification=https-upgrade'}});
const miss={status:404,headers:{'Cache-Control':'no-store'}};
const defaults={
  'https://example.com/_health':healthy,
  'http://example.com/_health?verification=https-upgrade':upgrade('example.com'),
  'https://example.com/verification--does-not-exist':miss,
  'https://example.com/admin/':accessLogin,
  'https://example.com/api/links':accessLogin,
  'https://example.com/api/export':accessLogin,
  'https://example.com/api/settings':accessLogin,
  'https://example.com/api/session':accessLogin,
  'https://example.com/assets/':accessLogin,
  'https://example.com/api/links/verification-probe':accessLogin,
  'https://example.com/api/links/verification-probe/image':accessLogin,
  'https://example.com/assets/index.js':accessLogin,
  'https://admin.example.com':accessLogin,
  'https://admin.example.com/api/links':accessLogin,
  'https://admin.example.com/api/export':accessLogin,
  'https://admin.example.com/api/settings':accessLogin,
  'https://admin.example.com/api/session':accessLogin,
  'https://admin.example.com/assets/':accessLogin,
  'https://admin.example.com/api/links/verification-probe':accessLogin,
  'https://admin.example.com/api/links/verification-probe/image':accessLogin,
  'https://admin.example.com/assets/index.js':accessLogin,
  'https://admin.example.com/%61pi/links':accessLogin,
  'https://admin.example.com/%61pi/export':accessLogin,
  'https://admin.example.com/%61pi/settings':accessLogin,
  'https://admin.example.com/%61pi/session':accessLogin,
  'http://admin.example.com/_health?verification=https-upgrade':upgrade('admin.example.com'),
  'https://example.com/%61pi/links':{status:404},
  'https://example.com/%61pi/export':{status:404},
  'https://example.com/%61pi/settings':{status:404},
  'https://example.com/%61pi/session':{status:404},
  'https://preview.example.com/_health':healthy,
  'https://preview.example.com/verification--does-not-exist':miss,
  'https://preview.example.com/api/links':{status:404},
  'https://preview.example.com/api/export':{status:404},
  'https://preview.example.com/api/settings':{status:404},
  'https://preview.example.com/api/session':{status:404},
  'https://preview.example.com/%61pi/links':{status:404},
  'https://preview.example.com/%61pi/export':{status:404},
  'https://preview.example.com/%61pi/settings':{status:404},
  'https://preview.example.com/%61pi/session':{status:404},
  'http://preview.example.com/_health?verification=https-upgrade':upgrade('preview.example.com'),
};
globalThis.setTimeout=(callback)=>{callback();return 0};
globalThis.fetch=async (url)=>{appendFileSync('urls.log',String(url)+'\\n');
const specification={...defaults,...overrides}[String(url)];
if(!specification) throw new Error('fixture request stopped: '+url);
// a login redirect names the requested hostname, as Cloudflare's own Access plugin builds it.
const headers={...specification.headers};
if(specification.login!==undefined) headers.Location='https://team.cloudflareaccess.com/cdn-cgi/access/login/'+new URL(String(url)).hostname+specification.login;
return new Response(specification.body??null,{status:specification.status,headers});};`;
// login is the query string of an Access login redirect whose path names the requested hostname.
interface Override { readonly status: number; readonly headers?: Record<string, string>; readonly body?: string; readonly login?: string }
const ACCESS_LOGIN_QUERY = "?kid=audience&redirect_url=%2Fapi%2Flinks";
const accessLogin: Override = { status: 302, login: ACCESS_LOGIN_QUERY };
const HTTPS_UPGRADE_QUERY = "?verification=https-upgrade";
const HSTS_HEADERS = { "Strict-Transport-Security": "max-age=31536000" };
const workerHealth: Override = { status: 200, headers: HSTS_HEADERS, body: JSON.stringify({ status: "ok" }) };
const workerRejection: Override = { status: 401, body: JSON.stringify({ error: WORKER_UNAUTHENTICATED_MESSAGE }) };
function verify(directory: string, overrides: Record<string, Override> = {}) {
  writeFileSync(join(directory, "verify-preload.mjs"), VERIFICATION_PRELOAD);
  return spawnSync(runtime, ["--import", "./verify-preload.mjs", "scripts/verify-deployment.ts"], {
    cwd: directory, env: environment(directory, { FIXTURE_OVERRIDES: JSON.stringify(overrides) }), encoding: "utf8",
  });
}
const MANAGEMENT_API_PATHS = ["/api/links", "/api/export", "/api/settings", "/api/session"];
function publicMisses(): Record<string, Override> {
  return Object.fromEntries(MANAGEMENT_API_PATHS.map((path) => [`https://example.com${path}`, { status: 404 }]));
}
function separateHostTarget(directory: string): void {
  const target = configuration("database-a");
  writeFileSync(join(directory, "wrangler.deploy.json"), JSON.stringify({ ...target, vars: { ...target.vars,
    ADMIN_ORIGIN: "https://admin.example.com", PREVIEW_ORIGIN: "https://preview.example.com" } }));
}
test("standalone verification and live fixture select canonical target instead of inventory", () => {
  const directory = fixture();
  try {
    const result = verify(directory);
    assert.equal(result.status, 0, result.stderr);
    const requested = readFileSync(join(directory, "urls.log"), "utf8");
    assert.match(requested, /https:\/\/example\.com\/_health/);
    assert.match(requested, /http:\/\/example\.com\/_health/);
    const preload = `import {appendFileSync} from 'node:fs';
globalThis.fetch=async (url)=>{appendFileSync('urls.log',String(url)+'\\n');throw new Error('fixture request stopped');};`;
    writeFileSync(join(directory, "preload.mjs"), preload);
    const fake = `#!${runtime}
import {appendFileSync} from 'node:fs';
appendFileSync('queries.log',JSON.stringify({args:process.argv.slice(2),account:process.env.CLOUDFLARE_ACCOUNT_ID})+'\\n');
process.stdout.write(JSON.stringify([{success:true}]));`;
    writeFileSync(join(directory, "bin", "cf"), fake);
    const live = spawnSync(runtime, ["--import", "./preload.mjs", "scripts/verify-live-links.ts"], { cwd: directory, env: environment(directory), encoding: "utf8" });
    assert.notEqual(live.status, 0);
    assert.match(live.stderr, /fixture request stopped/);
    const queryValue: unknown = JSON.parse(readFileSync(join(directory, "queries.log"), "utf8").split("\n")[0]!);
    const query = z.object({ args: z.array(z.string()), account: z.string() }).parse(queryValue);
    assert.equal(query.args[2], "database-a");
    assert.equal(query.account, "account");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
const WORKER_ANSWER_MESSAGE = /from the Worker, so Access does not cover this path/;
const REDIRECT_MESSAGE = /must permanently redirect to https:\/\/example\.com\/_health\?verification=https-upgrade/;
const ANOTHER_APPLICATION_MESSAGE = /Another Access application answered/;
const CHALLENGE_MESSAGE = /WAF or bot challenge/;
const INCONCLUSIVE_MESSAGE = /confirm the Access application's destinations in the Cloudflare dashboard/;
const SHARED_MANAGEMENT_URLS = ["https://example.com/api/links", "https://example.com/api/export", "https://example.com/api/settings",
  "https://example.com/api/session", "https://example.com/assets/", "https://example.com/admin/", "https://example.com/api/links/verification-probe",
  "https://example.com/api/links/verification-probe/image", "https://example.com/assets/index.js"];
const SEPARATE_MANAGEMENT_URLS = ["https://admin.example.com", "https://admin.example.com/api/links", "https://admin.example.com/api/export",
  "https://admin.example.com/api/settings", "https://admin.example.com/api/session", "https://admin.example.com/assets/",
  "https://admin.example.com/api/links/verification-probe", "https://admin.example.com/api/links/verification-probe/image", "https://admin.example.com/assets/index.js"];
const unrecognisedAnswers: ReadonlyArray<readonly [string, Override, RegExp]> = [
  ["a generic 403", { status: 403, body: "<html>Access denied</html>" }, INCONCLUSIVE_MESSAGE],
  ["an empty 401", { status: 401 }, INCONCLUSIVE_MESSAGE],
  ["unknown JSON", { status: 401, body: JSON.stringify({ error: "Unauthorised" }) }, INCONCLUSIVE_MESSAGE],
  ["a redirect to another team-domain path", { status: 302, headers: { Location: "https://team.cloudflareaccess.com/login" } }, INCONCLUSIVE_MESSAGE],
  ["a redirect to another origin", { status: 302, headers: { Location: "https://elsewhere.example.net/cdn-cgi/access/login/example.com?kid=audience" } }, INCONCLUSIVE_MESSAGE],
  ["a login for another hostname", { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/admin.example.com?kid=audience" } }, INCONCLUSIVE_MESSAGE],
  ["a login for a hostname that only starts like the request", { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/example.com.evil.example?kid=audience" } }, INCONCLUSIVE_MESSAGE],
  ["a login with a trailing path segment", { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/example.com/extra?kid=audience" } }, INCONCLUSIVE_MESSAGE],
  ["a relative redirect", { status: 302, headers: { Location: "/cdn-cgi/access/login/example.com" } }, INCONCLUSIVE_MESSAGE],
  ["a temporary redirect status", { status: 307, login: ACCESS_LOGIN_QUERY }, INCONCLUSIVE_MESSAGE],
  ["a login without a kid", { status: 302, login: "" }, INCONCLUSIVE_MESSAGE],
  ["a login with an empty kid", { status: 302, login: "?kid=" }, INCONCLUSIVE_MESSAGE],
  ["a login with a whitespace-only kid", { status: 302, login: "?kid=%20%09" }, INCONCLUSIVE_MESSAGE],
  ["a login whose kid carries a comma", { status: 302, login: "?kid=audience,other" }, INCONCLUSIVE_MESSAGE],
  // Headers joins repeated Location fields with a comma, so a joined pair can begin with this deployment's own login.
  ["a valid login joined with another Location field", { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/example.com?kid=audience, https://elsewhere.example.net/" } }, INCONCLUSIVE_MESSAGE],
  ["a comma in the redirect_url", { status: 302, login: "?kid=audience&redirect_url=%2Fa,b" }, INCONCLUSIVE_MESSAGE],
  ["a login with a duplicated kid", { status: 302, login: "?kid=audience&kid=audience" }, INCONCLUSIVE_MESSAGE],
  ["a login with a duplicated kid naming another application", { status: 302, login: "?kid=audience&kid=other" }, INCONCLUSIVE_MESSAGE],
  ["a served page", { status: 200 }, INCONCLUSIVE_MESSAGE],
  ["a cf-mitigated 403", { status: 403, headers: { "cf-mitigated": "challenge" }, body: "<html>Just a moment</html>" }, CHALLENGE_MESSAGE],
  ["a Worker 401", workerRejection, WORKER_ANSWER_MESSAGE],
  ["a Worker 403", { status: 403, body: JSON.stringify({ error: WORKER_FORBIDDEN_ORIGIN_MESSAGE }) }, WORKER_ANSWER_MESSAGE],
];
test("verification accepts only a recognisable Access login redirect on the primary management path", () => {
  const directory = fixture();
  try {
    for (const [description, answer, message] of unrecognisedAnswers) {
      const result = verify(directory, { "https://example.com/api/links": answer });
      assert.notEqual(result.status, 0, description);
      assert.match(result.stderr, message, description);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification rejects a login redirect that belongs to another Access application on the same team", () => {
  const directory = fixture();
  try {
    for (const login of ["?kid=other", "?kid=Audience", "?kid=audience%20", "?redirect_url=%2Fapi%2Flinks&kid=other"]) {
      const result = verify(directory, { "https://example.com/api/links": { status: 302, login } });
      assert.notEqual(result.status, 0, login);
      assert.match(result.stderr, ANOTHER_APPLICATION_MESSAGE, login);
    }
    const ownLogin = { status: 302, login: "?kid=audience&redirect_url=%2Fapi%2Flinks" };
    assert.equal(verify(directory, { "https://example.com/api/links": ownLogin }).status, 0);
    // the hostname in the login path is compared without regard to case.
    const uppercaseHostname = { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/EXAMPLE.com?kid=audience" } };
    assert.equal(verify(directory, { "https://example.com/api/links": uppercaseHostname }).status, 0);
    // the redirect_url parameter is not validated, so its absence or any value is accepted.
    assert.equal(verify(directory, { "https://example.com/api/links": { status: 302, login: "?kid=audience" } }).status, 0);
    separateHostTarget(directory);
    const otherOnAdminUpgrade = { status: 302, login: "?kid=other" };
    const result = verify(directory, { ...publicMisses(), "http://admin.example.com/_health?verification=https-upgrade": otherOnAdminUpgrade });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Plain HTTP on the admin hostname/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification probes the sampled management paths on a shared hostname", () => {
  const directory = fixture();
  try {
    for (const url of SHARED_MANAGEMENT_URLS) {
      const result = verify(directory, { [url]: workerRejection });
      assert.notEqual(result.status, 0, url);
      assert.match(result.stderr, WORKER_ANSWER_MESSAGE, url);
      assert.match(result.stderr, new RegExp(url.replaceAll(".", "\\.")), url);
      const inconclusive = verify(directory, { [url]: { status: 403, body: "<html>Access denied</html>" } });
      assert.notEqual(inconclusive.status, 0, url);
      assert.match(inconclusive.stderr, INCONCLUSIVE_MESSAGE, url);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification probes the sampled management paths on a separate admin hostname", () => {
  const directory = fixture();
  try {
    separateHostTarget(directory);
    const publicMiss = publicMisses();
    for (const url of SEPARATE_MANAGEMENT_URLS) {
      const workerAnswered = verify(directory, { ...publicMiss, [url]: workerRejection });
      assert.notEqual(workerAnswered.status, 0, url);
      assert.match(workerAnswered.stderr, WORKER_ANSWER_MESSAGE, url);
      const inconclusive = verify(directory, { ...publicMiss, [url]: { status: 403, body: "<html>Access denied</html>" } });
      assert.notEqual(inconclusive.status, 0, url);
      assert.match(inconclusive.stderr, INCONCLUSIVE_MESSAGE, url);
    }
    assert.equal(verify(directory, publicMiss).status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification applies Access probes to the separate admin host", () => {
  const directory = fixture();
  try {
    separateHostTarget(directory);
    const healthy = verify(directory, publicMisses());
    assert.equal(healthy.status, 0, healthy.stderr);
    const adminAnsweredByWorker = verify(directory, { ...publicMisses(), "https://admin.example.com/api/links": workerRejection });
    assert.notEqual(adminAnsweredByWorker.status, 0);
    assert.match(adminAnsweredByWorker.stderr, WORKER_ANSWER_MESSAGE);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification probes encoded management paths on the public, separate admin and preview hosts", () => {
  const directory = fixture();
  try {
    separateHostTarget(directory);
    const encodedPaths = ["/%61pi/links", "/%61pi/export", "/%61pi/settings", "/%61pi/session"];
    for (const [origin, host] of [["https://example.com", "example\\.com"], ["https://admin.example.com", "admin\\.example\\.com"], ["https://preview.example.com", "preview\\.example\\.com"]] as const) {
      for (const path of encodedPaths) {
        const served = verify(directory, { ...publicMisses(), [`${origin}${path}`]: { status: 200, body: "[]" } });
        assert.notEqual(served.status, 0, `${origin}${path}`);
        assert.match(served.stderr, new RegExp(`${host}${path}.*the Worker served data for an encoded management path`), `${origin}${path}`);
      }
    }
    // the admin hostname accepts only this application's login redirect or a 404 for an encoded path.
    for (const path of encodedPaths) {
      const url = `https://admin.example.com${path}`;
      assert.equal(verify(directory, { ...publicMisses(), [url]: { status: 404 } }).status, 0, url);
      const workerAnswered = verify(directory, { ...publicMisses(), [url]: workerRejection });
      assert.notEqual(workerAnswered.status, 0, url);
      assert.match(workerAnswered.stderr, WORKER_ANSWER_MESSAGE, url);
      const otherApplication = verify(directory, { ...publicMisses(), [url]: { status: 302, login: "?kid=other" } });
      assert.notEqual(otherApplication.status, 0, url);
      assert.match(otherApplication.stderr, ANOTHER_APPLICATION_MESSAGE, url);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification requires 404 for the plain management API paths on the public and preview hostnames", () => {
  const directory = fixture();
  try {
    separateHostTarget(directory);
    for (const path of MANAGEMENT_API_PATHS) {
      for (const [origin, label] of [["https://example.com", "public"], ["https://preview.example.com", "preview"]] as const) {
        for (const answer of [{ status: 200 }, accessLogin, workerRejection, { status: 403 }]) {
          const result = verify(directory, { ...publicMisses(), [`${origin}${path}`]: answer });
          assert.notEqual(result.status, 0, `${origin}${path} ${answer.status}`);
          assert.match(result.stderr, new RegExp(`${origin.replaceAll(".", "\\.")}${path}.*must not be exposed on the ${label} hostname`), `${origin}${path}`);
        }
      }
    }
    // a configured preview hostname is also checked when the admin panel shares the public hostname, where the public paths are Access-protected instead.
    const target = configuration("database-a");
    writeFileSync(join(directory, "wrangler.deploy.json"), JSON.stringify({ ...target, vars: { ...target.vars, PREVIEW_ORIGIN: "https://preview.example.com" } }));
    const sharedWithPreview = verify(directory);
    assert.equal(sharedWithPreview.status, 0, sharedWithPreview.stderr);
    const exposedOnPreview = verify(directory, { "https://preview.example.com/api/session": { status: 200 } });
    assert.notEqual(exposedOnPreview.status, 0);
    assert.match(exposedOnPreview.stderr, /preview\.example\.com\/api\/session.*must not be exposed on the preview hostname/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification fails when an encoded management path is served", () => {
  const directory = fixture();
  try {
    for (const url of ["https://example.com/%61pi/links", "https://example.com/%61pi/export", "https://example.com/%61pi/settings", "https://example.com/%61pi/session"]) {
      const result = verify(directory, { [url]: { status: 200, body: "[]" } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /the Worker served data for an encoded management path/);
      assert.doesNotMatch(result.stderr, /answered by Cloudflare Access/);
      const workerAnswered = verify(directory, { [url]: workerRejection });
      assert.notEqual(workerAnswered.status, 0);
      assert.match(workerAnswered.stderr, WORKER_ANSWER_MESSAGE);
      const inconclusive = verify(directory, { [url]: { status: 403, body: "<html>Access denied</html>" } });
      assert.notEqual(inconclusive.status, 0);
      assert.match(inconclusive.stderr, INCONCLUSIVE_MESSAGE);
      assert.equal(verify(directory, { [url]: accessLogin }).status, 0);
    }
    separateHostTarget(directory);
    const overrides = publicMisses();
    for (const url of ["https://preview.example.com/%61pi/links", "https://preview.example.com/%61pi/export", "https://preview.example.com/%61pi/settings", "https://preview.example.com/%61pi/session"]) {
      const result = verify(directory, { ...overrides, [url]: { status: 200 } });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /preview\.example\.com.*the Worker served data for an encoded management path/);
    }
    const previewNotUpgraded = verify(directory, { ...overrides, [`http://preview.example.com/_health${HTTPS_UPGRADE_QUERY}`]: { status: 200 } });
    assert.notEqual(previewNotUpgraded.status, 0);
    assert.match(previewNotUpgraded.stderr, /must permanently redirect to https:\/\/preview\.example\.com\/_health\?verification=https-upgrade/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("Strict-Transport-Security parsing applies a strict RFC 6797 subset and requires one year", () => {
  const verdictFor = (value: string | null) => classifyStrictTransportSecurity(new Response(null, value === null ? {} : { headers: { "Strict-Transport-Security": value } }));
  for (const accepted of ["max-age=31536000", 'max-age="31536000"', "Max-Age=31536000", "max-age=31536000; includeSubDomains", "includeSubDomains; max-age=63072000; preload",
    "max-age=31536000;", "  max-age=31536000 ;  includeSubDomains", "max-age=0031536000", "max-age = 31536000", "max-age\t=\t31536000; includeSubDomains",
    'max-age = "31536000"', "INCLUDESUBDOMAINS; max-age=31536000", "max-age=31536000; foo", "max-age=31536000; foo=bar", 'max-age=31536000; foo="bar baz"',
    'max-age=31536000; note="a;b"']) {
    assert.equal(verdictFor(accepted), "valid", accepted);
  }
  for (const rejected of [null, "", "max-age=31536000bad", "max-age=31536000; max-age=31536000", "max-age=31536000; MAX-AGE=63072000", "includeSubDomains",
    "max-age=1", "max-age=0", "max-age=31535999", "max-age=", 'max-age="31536000', "max-age=-31536000", "max-age=+31536000", "max-age=3.1536e7", "max-age",
    "max-age=31536000; includeSubDomains; includeSubDomains", "max-age=31536000; foo bar", "max-age=31536000; foo@bar", "max-age=31536000; (foo)",
    "max-age=31536000; =value", "max age=31536000", "max-age=31536000 31536000",
    // directive values must be a token or quoted string, and the two valueless directives take none.
    "max-age=31536000; includeSubDomains=1", "max-age=31536000; preload=true", 'max-age=31536000; includeSubDomains=""', "max-age=31536000; foo=bar baz",
    "max-age=31536000; foo=", "max-age=31536000; foo = ",
    // only space and horizontal tab are optional whitespace, so other whitespace is part of the value or name. Headers accepts only code points up to U+00FF.
    "max-age=\u00a031536000", "max-age=31536000\u00a0", "\u00a0max-age=31536000", "max-age=31536000; includeSubDomains\u00a0", "max-age=31536000;\u0085includeSubDomains", 'max-age=31536000; foo="unterminated', 'max-age=31536000; foo=a"b"', "max-age=31536000; foo=a/b", 'max-age=31536000; foo="a\\"']) {
    assert.equal(verdictFor(rejected), "invalid", String(rejected));
  }
  // a comma outside a quoted string means repeated fields or a malformed one, and the field boundaries cannot be recovered from the joined value.
  for (const ambiguous of ["max-age=31536000, max-age=31536000; includeSubDomains", "max-age=31536000; includeSubDomains, max-age=63072000", "max-age=31536000, max-age=1",
    "max-age=31536000, nonsense !!", "max-age=1, max-age=31536000", "includeSubDomains, max-age=31536000", ", max-age=31536000", "max-age=31536000,", "max-age=31536000; foo=a,b",
    // a comma inside a quoted string is rejected too, because a joined pair of malformed fields can form a quoted comma.
    'max-age=31536000; foo="a, b"', 'max-age=31536000; note="a, b"', 'note="a, b"; max-age=31536000', 'note="a\\", b"; max-age=31536000', 'max-age="31536000, "']) {
    assert.equal(verdictFor(ambiguous), "multiple-or-malformed-fields", ambiguous);
  }
  const repeated = (...values: string[]) => classifyStrictTransportSecurity(new Response(null, { headers: values.map((value) => ["Strict-Transport-Security", value] as [string, string]) }));
  assert.equal(repeated("max-age=31536000", "max-age=31536000; includeSubDomains"), "multiple-or-malformed-fields");
  assert.equal(repeated("max-age=31536000; includeSubDomains", "max-age=1"), "multiple-or-malformed-fields");
  assert.equal(repeated("max-age=1", "max-age=31536000"), "multiple-or-malformed-fields");
  assert.equal(repeated("max-age=31536000; includeSubDomains"), "valid");
  // two fields that are each malformed join into a value that parses as one valid field if commas inside quotes are tolerated.
  assert.equal(repeated('max-age="31536000', '"'), "multiple-or-malformed-fields");
  assert.equal(repeated("max-age=31536000; foo=\"a", 'b"'), "multiple-or-malformed-fields");
  assert.equal(new Headers([["Strict-Transport-Security", 'max-age="31536000'], ["Strict-Transport-Security", '"']]).get("Strict-Transport-Security"), 'max-age="31536000, "');
});
test("a joined pair of malformed Location fields is inconclusive even when it begins with this deployment's login", async () => {
  const login = "https://team.cloudflareaccess.com/cdn-cgi/access/login/example.com?kid=audience";
  const joined = new Response(null, { status: 302, headers: [["Location", login], ["Location", "https://elsewhere.example.net/"]] });
  assert.equal(joined.headers.get("Location"), `${login}, https://elsewhere.example.net/`);
  assert.equal(await classifyManagementAnswer(joined, "https://example.com/api/links", "https://team.cloudflareaccess.com", "audience"), "inconclusive");
  const single = new Response(null, { status: 302, headers: { Location: login } });
  assert.equal(await classifyManagementAnswer(single, "https://example.com/api/links", "https://team.cloudflareaccess.com", "audience"), "access-login");
});
test("verification requires exactly one valid HSTS field on the public and preview health responses", () => {
  const directory = fixture();
  try {
    const withoutHsts = verify(directory, { "https://example.com/_health": { ...workerHealth, headers: {} } });
    assert.notEqual(withoutHsts.status, 0);
    assert.match(withoutHsts.stderr, /Public health must send a valid Strict-Transport-Security/);
    for (const invalid of ["max-age=\u00a031536000", "max-age=0", "max-age=1", "max-age=31536000bad", "max-age=31536000; max-age=31536000", "max-age=31536000; foo bar", "max-age=31536000; includeSubDomains=1",
      "max-age=31536000; foo="]) {
      const result = verify(directory, { "https://example.com/_health": { ...workerHealth, headers: { "Strict-Transport-Security": invalid } } });
      assert.notEqual(result.status, 0, invalid);
      assert.match(result.stderr, /Public health must send a valid Strict-Transport-Security/, invalid);
    }
    for (const ambiguous of ["max-age=1, max-age=31536000", "max-age=31536000, max-age=31536000; includeSubDomains", "max-age=31536000, nonsense !!",
      'max-age="31536000, "', 'max-age=31536000; foo="a, b"']) {
      const result = verify(directory, { "https://example.com/_health": { ...workerHealth, headers: { "Strict-Transport-Security": ambiguous } } });
      assert.notEqual(result.status, 0, ambiguous);
      assert.match(result.stderr, /Public health carries more than one Strict-Transport-Security field, or a malformed one, and must carry exactly one/, ambiguous);
    }
    for (const valid of ["max-age = 31536000", 'max-age="31536000"; includeSubDomains', "max-age=31536000; includeSubDomains; preload"]) {
      const result = verify(directory, { "https://example.com/_health": { ...workerHealth, headers: { "Strict-Transport-Security": valid } } });
      assert.equal(result.status, 0, result.stderr);
    }
    separateHostTarget(directory);
    const publicMiss = publicMisses();
    const previewWithoutHsts = verify(directory, { ...publicMiss, "https://preview.example.com/_health": { ...workerHealth, headers: {} } });
    assert.notEqual(previewWithoutHsts.status, 0);
    assert.match(previewWithoutHsts.stderr, /Preview health must send a valid Strict-Transport-Security/);
    const previewRepeated = verify(directory, { ...publicMiss, "https://preview.example.com/_health": { ...workerHealth, headers: { "Strict-Transport-Security": "max-age=1, max-age=31536000" } } });
    assert.notEqual(previewRepeated.status, 0);
    assert.match(previewRepeated.stderr, /Preview health carries more than one Strict-Transport-Security field/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification requires the Worker's health body and an uncached preview miss", () => {
  const directory = fixture();
  try {
    for (const unrelated of [{ status: 404 }, { status: 200, headers: HSTS_HEADERS, body: "<html>welcome</html>" },
      { status: 200, headers: HSTS_HEADERS, body: JSON.stringify({ status: "degraded" }) }, { status: 200, headers: HSTS_HEADERS }]) {
      const result = verify(directory, { "https://example.com/_health": unrelated });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /without the Worker's \{"status":"ok"\} body/);
    }
    separateHostTarget(directory);
    const publicMiss = publicMisses();
    const previewUnrelated = verify(directory, { ...publicMiss, "https://preview.example.com/_health": { status: 404 } });
    assert.notEqual(previewUnrelated.status, 0);
    assert.match(previewUnrelated.stderr, /Preview health returned 404/);
    const previewCached = verify(directory, { ...publicMiss, "https://preview.example.com/verification--does-not-exist": { status: 404 } });
    assert.notEqual(previewCached.status, 0);
    assert.match(previewCached.stderr, /preview hostname must return an uncached 404/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification judges the uncached miss by its no-store directive on both hosts", () => {
  const directory = fixture();
  try {
    const missWith = (cacheControl: string | null): Override => ({ status: 404, headers: cacheControl === null ? {} : { "Cache-Control": cacheControl } });
    for (const accepted of ["no-store", "private, no-store", "No-Store, max-age=0", 'no-cache, no-store, must-revalidate', "NO-STORE", " \tno-store\t ", "no-store, private", "no-store, no-store"]) {
      const result = verify(directory, { "https://example.com/verification--does-not-exist": missWith(accepted) });
      assert.equal(result.status, 0, `${accepted}: ${result.stderr}`);
    }
    for (const rejected of [null, "public, max-age=60", "no-cache", "private", "no-store-ish", 'private; note="no-store"',
      // no-store must be a bare directive, and must-understand lets a cache store the response despite no-store.
      'no-store="off"', "no-store=off", "no-store = 1", "private, no-store=false", "no-store, no-store=false", "no-store, must-understand", "must-understand, no-store",
      "No-Store, Must-Understand", "no-store, must-understand=1", 'no-store, must-understand="x"', "no-store\u00a0", "\u00a0no-store"]) {
      const result = verify(directory, { "https://example.com/verification--does-not-exist": missWith(rejected) });
      assert.notEqual(result.status, 0, String(rejected));
      assert.match(result.stderr, /Unknown shortlinks must return an uncached 404/, String(rejected));
    }
    separateHostTarget(directory);
    const publicMiss = publicMisses();
    const previewMiss = (cacheControl: string | null) => ({ ...publicMiss, "https://preview.example.com/verification--does-not-exist": missWith(cacheControl) });
    assert.equal(verify(directory, previewMiss("private, no-store")).status, 0);
    const previewCached = verify(directory, previewMiss("private"));
    assert.notEqual(previewCached.status, 0);
    assert.match(previewCached.stderr, /preview hostname must return an uncached 404/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("an uncached response needs a bare no-store directive and no must-understand", () => {
  const verdictFor = (...values: string[]) => isUncachedResponse(new Response(null, { headers: values.map((value) => ["Cache-Control", value] as [string, string]) }));
  assert.equal(verdictFor("private, no-store"), true);
  assert.equal(verdictFor("private", "no-store"), true);
  assert.equal(verdictFor('private; note="a, no-store"'), false);
  assert.equal(verdictFor('private, extension="a, b", no-store'), true);
  assert.equal(verdictFor('no-store="off"'), false);
  assert.equal(verdictFor("no-store", "must-understand"), false);
  assert.equal(isUncachedResponse(new Response(null)), false);
});
test("an uncached response fails on explicit cache-hit evidence and tolerates the other cache statuses", () => {
  const responseWith = (headers: Record<string, string>) => new Response(null, { status: 404, headers: { "Cache-Control": "no-store", ...headers } });
  for (const status of ["HIT", "hit", "STALE", "REVALIDATED", "UPDATING", "Updating", " HIT "]) {
    assert.equal(isUncachedResponse(responseWith({ "CF-Cache-Status": status })), false, status);
  }
  for (const age of ["0", "120", ""]) {
    assert.equal(isUncachedResponse(responseWith({ Age: age })), false, `Age: ${age}`);
  }
  assert.equal(isUncachedResponse(responseWith({ "CF-Cache-Status": "HIT", Age: "120" })), false);
  for (const status of ["MISS", "BYPASS", "DYNAMIC", "EXPIRED", "miss"]) {
    assert.equal(isUncachedResponse(responseWith({ "CF-Cache-Status": status })), true, status);
  }
  assert.equal(isUncachedResponse(responseWith({})), true);
});
test("verification fails a no-store miss that a cache served on both hosts", () => {
  const directory = fixture();
  try {
    const cachedMisses: Record<string, string>[] = [{ "CF-Cache-Status": "HIT", Age: "120" }, { "CF-Cache-Status": "STALE" }, { Age: "5" }];
    const uncachedMisses: Record<string, string>[] = [{ "CF-Cache-Status": "MISS" }, { "CF-Cache-Status": "BYPASS" }, { "CF-Cache-Status": "DYNAMIC" }, { "CF-Cache-Status": "EXPIRED" }];
    const missWith = (headers: Record<string, string>): Override => ({ status: 404, headers: { "Cache-Control": "no-store", ...headers } });
    for (const headers of cachedMisses) {
      const result = verify(directory, { "https://example.com/verification--does-not-exist": missWith(headers) });
      assert.notEqual(result.status, 0, JSON.stringify(headers));
      assert.match(result.stderr, /Unknown shortlinks must return an uncached 404/, JSON.stringify(headers));
    }
    for (const headers of uncachedMisses) {
      const result = verify(directory, { "https://example.com/verification--does-not-exist": missWith(headers) });
      assert.equal(result.status, 0, `${JSON.stringify(headers)}: ${result.stderr}`);
    }
    separateHostTarget(directory);
    const previewMiss = (headers: Record<string, string>) => ({ ...publicMisses(), "https://preview.example.com/verification--does-not-exist": missWith(headers) });
    for (const headers of cachedMisses) {
      const result = verify(directory, previewMiss(headers));
      assert.notEqual(result.status, 0, JSON.stringify(headers));
      assert.match(result.stderr, /preview hostname must return an uncached 404/, JSON.stringify(headers));
    }
    for (const headers of uncachedMisses) {
      const result = verify(directory, previewMiss(headers));
      assert.equal(result.status, 0, `${JSON.stringify(headers)}: ${result.stderr}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("the unknown-shortlink sentinel can never be claimed as a custom slug", () => {
  const sentinel = /^const UNKNOWN_SHORTLINK_PATH = "\/([^"]+)";$/m.exec(readFileSync(join(root, "scripts", "verify-deployment.ts"), "utf8"));
  assert.ok(sentinel, "verify-deployment.ts must declare UNKNOWN_SHORTLINK_PATH");
  const slugPattern = /if \(!(\/\^[^\n]*?\$\/)\.test\(slug\)/.exec(readFileSync(join(root, "src", "slugs.ts"), "utf8"));
  assert.ok(slugPattern, "src/slugs.ts must still test the slug against a pattern in parseCustomSlug");
  const body = slugPattern[1]!;
  const acceptsSlug = new RegExp(body.slice(1, body.lastIndexOf("/")));
  // the pattern must still accept an ordinary hyphenated slug while rejecting consecutive hyphens.
  assert.equal(acceptsSlug.test("verification-does-not-exist"), true);
  assert.equal(acceptsSlug.test("a--b"), false);
  assert.match(sentinel[1]!, /--/);
  assert.equal(acceptsSlug.test(sentinel[1]!), false);
});
test("verification requires a permanent HTTPS redirect that preserves the query string", () => {
  const directory = fixture();
  try {
    const url = `http://example.com/_health${HTTPS_UPGRADE_QUERY}`;
    const location = `https://example.com/_health${HTTPS_UPGRADE_QUERY}`;
    const notRedirected = verify(directory, { [url]: { status: 200 } });
    assert.notEqual(notRedirected.status, 0);
    assert.match(notRedirected.stderr, /must permanently redirect to https:\/\/example\.com\/_health\?verification=https-upgrade/);
    for (const dropped of ["https://example.com/_health", "https://example.com/", "https://example.com/_health?verification=other", `${location}&extra=1`]) {
      const result = verify(directory, { [url]: { status: 308, headers: { Location: dropped } } });
      assert.notEqual(result.status, 0, dropped);
      assert.match(result.stderr, REDIRECT_MESSAGE, dropped);
    }
    for (const temporary of [302, 303, 307]) {
      const result = verify(directory, { [url]: { status: temporary, headers: { Location: location } } });
      assert.notEqual(result.status, 0, String(temporary));
      assert.match(result.stderr, REDIRECT_MESSAGE, String(temporary));
    }
    const edgeRedirect = verify(directory, { [url]: { status: 301, headers: { Location: location } } });
    assert.equal(edgeRedirect.status, 0, edgeRedirect.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification accepts an HTTPS redirect or the Access login for plain HTTP on the admin hostname", () => {
  const directory = fixture();
  try {
    separateHostTarget(directory);
    const publicMiss = publicMisses();
    const url = `http://admin.example.com/_health${HTTPS_UPGRADE_QUERY}`;
    const location = `https://admin.example.com/_health${HTTPS_UPGRADE_QUERY}`;
    assert.equal(verify(directory, { ...publicMiss, [url]: { status: 301, headers: { Location: location } } }).status, 0);
    assert.equal(verify(directory, { ...publicMiss, [url]: accessLogin }).status, 0);
    const challenged = verify(directory, { ...publicMiss, [url]: { status: 302, login: ACCESS_LOGIN_QUERY, headers: { "cf-mitigated": "challenge" } } });
    assert.notEqual(challenged.status, 0);
    assert.match(challenged.stderr, /Plain HTTP on the admin hostname returned 302 with a cf-mitigated header/);
    const challengedRedirect = verify(directory, { ...publicMiss, [url]: { status: 308, headers: { Location: location, "cf-mitigated": "challenge" } } });
    assert.notEqual(challengedRedirect.status, 0);
    assert.match(challengedRedirect.stderr, /cf-mitigated header/);
    for (const rejected of [{ status: 200 }, { status: 403 }, { status: 308, headers: { Location: "https://admin.example.com/_health" } },
      { status: 302, headers: { Location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/example.com?kid=audience" } },
      { status: 302, login: "" }, { status: 302, login: "?kid=audience&kid=audience" },
      { status: 302, headers: { Location: "https://team.cloudflareaccess.com/login" } }, { status: 302, headers: { Location: location } }]) {
      const result = verify(directory, { ...publicMiss, [url]: rejected });
      assert.notEqual(result.status, 0, JSON.stringify(rejected));
      assert.match(result.stderr, /admin hostname/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("verification probes mirror the rejection messages and HSTS lifetime in the Worker source", () => {
  const source = readFileSync(join(root, "src", "index.ts"), "utf8");
  assert.ok(source.includes(JSON.stringify(WORKER_UNAUTHENTICATED_MESSAGE)));
  assert.ok(source.includes(JSON.stringify(WORKER_FORBIDDEN_ORIGIN_MESSAGE)));
  assert.ok(source.includes("HSTS_MAX_AGE_SECONDS = 31_536_000;"));
});
test("profiling limits mirror the contract limits in shared/contracts.ts", () => {
  const limitIn = (file: string, name: string): string => {
    const declaration = new RegExp(`^(?:export )?const ${name} = (\\d+);$`, "m").exec(readFileSync(join(root, file), "utf8"));
    assert.ok(declaration, `${file} must declare ${name}`);
    return declaration[1]!;
  };
  const contractTitleLimit = limitIn("shared/contracts.ts", "MAXIMUM_TITLE_LENGTH");
  const contractDisplayNameLimit = limitIn("shared/contracts.ts", "MAXIMUM_DISPLAY_NAME_LENGTH");
  assert.equal(limitIn("scripts/preview-profile-title.ts", "MAXIMUM_TITLE_LENGTH"), contractTitleLimit);
  assert.equal(limitIn("scripts/profile-preview.ts", "MAXIMUM_DISPLAY_NAME_LENGTH"), contractDisplayNameLimit);
});
test("deployment configuration requires workers.dev and preview URLs to be disabled", () => {
  const directory = fixture();
  try {
    const path = join(directory, "wrangler.deploy.json");
    readDeploymentTarget(path);
    for (const flag of ["workers_dev", "preview_urls"] as const) {
      const { [flag]: _omitted, ...withoutFlag } = configuration("database-a");
      for (const target of [{ ...configuration("database-a"), [flag]: true }, withoutFlag]) {
        writeFileSync(path, JSON.stringify(target));
        assert.throws(() => readDeploymentTarget(path), flag);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("invalid deployment origins fail before build or mutation", () => {
  for (const [patch, expectedMessage] of [
    [{ ACCESS_ISSUER: "https://untrusted.example.com" }, /Invalid deployment origins/],
    [{ PREVIEW_ORIGIN: "https://example.com" }, /Invalid deployment origins/],
    [{ ADMIN_ORIGIN: "http://example.com" }, /ADMIN_ORIGIN/],
  ] as const) {
    const directory = fixture();
    try {
      const target = configuration("database-a");
      writeFileSync(join(directory, "wrangler.deploy.json"), JSON.stringify({ ...target, vars: { ...target.vars, ...patch } }));
      const result = deploy(directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expectedMessage, JSON.stringify(patch));
      assert.deepEqual(calls(directory), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});
test("generated variable key order does not change the target", () => {
  const directory = fixture();
  try {
    const target = readDeploymentTarget(join(directory, "wrangler.deploy.json"));
    const path = join(directory, "output", "worker", "wrangler.json");
    mkdirSync(join(directory, "output", "worker"), { recursive: true });
    const vars = Object.fromEntries(Object.entries(target.vars).reverse());
    writeFileSync(path, JSON.stringify({ ...target, main: "index.js", assets: { directory: "../client" }, vars }));
    validateGeneratedTarget(path, target, join(directory, "output"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("malformed shared Vite pointer cannot interrupt owned cleanup", () => {
  const directory = fixture();
  try {
    mkdirSync(join(directory, "admin", ".wrangler", "deploy"), { recursive: true });
    const pointer = join(directory, "admin", ".wrangler", "deploy", "config.json");
    writeFileSync(pointer, "{");
    assert.equal(deploy(directory).status, 0);
    const entries = calls(directory);
    assert.throws(() => readFileSync(entries[0]!.snapshot!));
    assert.equal(readFileSync(pointer, "utf8"), "{");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test("font staging occurs outside the public assets directory", () => {
  const directory = fixture();
  try {
    copyFileSync(join(root, "scripts", "copy-fonts.ts"), join(directory, "scripts", "copy-fonts.ts"));
    const preload = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.copyFileSync;fs.copyFileSync=(source,destination,...rest)=>{fs.appendFileSync('font-staging.log',String(destination)+'\\n');return original(source,destination,...rest)};syncBuiltinESMExports();`;
    writeFileSync(join(directory, "preload.mjs"), preload);
    const result = spawnSync(runtime, ["--import", "./preload.mjs", "scripts/copy-fonts.ts"], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const paths = readFileSync(join(directory, "font-staging.log"), "utf8").trim().split("\n");
    assert.equal(paths.length, 2);
    assert.ok(paths.every((path) => path.startsWith("admin/.font-staging/")));
    assert.ok(readFileSync(join(directory, "admin/public/_fonts/inter.woff2")).length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("generated routes match captured custom domains semantically", () => {
  const directory = fixture();
  try {
    const target = readDeploymentTarget(join(directory, "wrangler.deploy.json"));
    const path = join(directory, "output", "worker", "wrangler.json");
    mkdirSync(join(directory, "output", "worker"), { recursive: true });
    const generated = { ...target, main: "index.js", assets: { directory: "../client" } };
    writeFileSync(path, JSON.stringify({ ...generated, routes: [{ custom_domain: true, pattern: "example.com" }] }));
    validateGeneratedTarget(path, target, join(directory, "output"));
    for (const routes of [[{ pattern: "other.example.com", custom_domain: true }], [{ pattern: "example.com", custom_domain: false }], []]) {
      writeFileSync(path, JSON.stringify({ ...generated, routes }));
      assert.throws(() => validateGeneratedTarget(path, target, join(directory, "output")));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
