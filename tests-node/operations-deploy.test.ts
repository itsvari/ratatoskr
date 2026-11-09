import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { readDeploymentTarget, validateGeneratedTarget } from "../scripts/deployment-configuration.ts";

const root = process.cwd();
const runtime = process.execPath;
function configuration(database: string) {
  return { name: "test-hyphen", account_id: "account", routes: [{ pattern: "example.com", custom_domain: true }], main: "src/index.ts", assets: { directory: "dist/client" },
    vars: { SHORT_ORIGIN: "https://example.com", ADMIN_ORIGIN: "https://example.com", PREVIEW_ORIGIN: "", ACCESS_ISSUER: "https://team.cloudflareaccess.com", ACCESS_AUDIENCE: "audience", ADMIN_EMAILS: "admin@example.com" },
    d1_databases: [{ binding: "DB", database_name: "test-hyphen", database_id: database, migrations_dir: "migrations" }] };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ratatoskr-operations-"));
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "bin"));
  for (const name of ["deploy.ts", "cloudflare.ts", "deployment-configuration.ts", "verify-deployment.ts", "verify-live-links.ts", "deployment-http.ts"]) {
    copyFileSync(join(root, "scripts", name), join(directory, "scripts", name));
  }
  symlinkSync(join(root, "node_modules"), join(directory, "node_modules"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(directory, "wrangler.deploy.json"), JSON.stringify(configuration("database-a")));
  writeFileSync(join(directory, "deployment-state.json"), JSON.stringify({ databaseId: "stale-database" }));
  const fake = `#!${runtime}
import {appendFileSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
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
} else if(stage==='cf') {
  record({stage:'migrate',database:args[3],account:process.env.CLOUDFLARE_ACCOUNT_ID});
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
  for (const [failure, expected] of [["build", ["build"]], ["invalid", ["build"]], ["route", ["build"]], ["migrate", ["build", "migrate"]], ["publish", ["build", "migrate", "publish"]], ["verify", ["build", "migrate", "publish", "verify"]]] as const) {
    const directory = fixture();
    try {
      assert.notEqual(deploy(directory, { FAIL_STAGE: failure }).status, 0);
      const entries = calls(directory);
      assert.deepEqual(entries.map((entry) => entry.stage), expected);
      assert.throws(() => readFileSync(entries[0]!.snapshot!));
      if (failure === "publish" || failure === "verify") assert.ok(readFileSync(entries[2]!.path!));
      else assert.throws(() => readFileSync(join(entries[0]!.output!, "worker", "wrangler.json")));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
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
test("standalone verification and live fixture select canonical target instead of inventory", () => {
  const directory = fixture();
  try {
    const preload = `import {appendFileSync} from 'node:fs';
globalThis.fetch=async (url)=>{appendFileSync('urls.log',String(url)+'\\n');
const path=new URL(url).pathname;
if(path==='/_health') return new Response('',{status:200});
if(path==='/verification-does-not-exist') return new Response('',{status:404,headers:{'Cache-Control':'no-store'}});
if(path==='/admin/') return new Response(null,{status:302,headers:{Location:'https://team.cloudflareaccess.com/login'}});
if(path==='/api/links') return new Response(null,{status:401});
throw new Error('fixture request stopped');};`;
    writeFileSync(join(directory, "preload.mjs"), preload);
    const verify = spawnSync(runtime, ["--import", "./preload.mjs", "scripts/verify-deployment.ts"], { cwd: directory, env: environment(directory), encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(readFileSync(join(directory, "urls.log"), "utf8"), /https:\/\/example\.com\/_health/);
    const fake = `#!${runtime}
import {appendFileSync} from 'node:fs';
appendFileSync('queries.log',JSON.stringify({args:process.argv.slice(2),account:process.env.CLOUDFLARE_ACCOUNT_ID})+'\\n');
process.stdout.write(JSON.stringify([{success:true}]));`;
    writeFileSync(join(directory, "bin", "cf"), fake);
    const live = spawnSync(runtime, ["--import", "./preload.mjs", "scripts/verify-live-links.ts"], { cwd: directory, env: environment(directory), encoding: "utf8" });
    assert.notEqual(live.status, 0);
    const queryValue: unknown = JSON.parse(readFileSync(join(directory, "queries.log"), "utf8").split("\n")[0]!);
    const query = z.object({ args: z.array(z.string()), account: z.string() }).parse(queryValue);
    assert.equal(query.args[2], "database-a");
    assert.equal(query.account, "account");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("invalid deployment origins fail before build or mutation", () => {
  for (const patch of [
    { ACCESS_ISSUER: "https://untrusted.example.com" },
    { PREVIEW_ORIGIN: "https://example.com" },
    { ADMIN_ORIGIN: "http://example.com" },
  ]) {
    const directory = fixture();
    try {
      const target = configuration("database-a");
      writeFileSync(join(directory, "wrangler.deploy.json"), JSON.stringify({ ...target, vars: { ...target.vars, ...patch } }));
      assert.notEqual(deploy(directory).status, 0);
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
