import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEPLOYMENT_CONFIGURATION_PATH, run } from "./cloudflare.ts";
import { readDeploymentTarget, validateGeneratedTarget } from "./deployment-configuration.ts";

const configurationPath = resolve(DEPLOYMENT_CONFIGURATION_PATH);
const target = readDeploymentTarget(configurationPath);
const identifier = crypto.randomUUID();
const snapshot = resolve(dirname(configurationPath), `.ratatoskr-deploy-${identifier}.json`);
const output = resolve(`.wrangler/deployments/${identifier}/dist`);
const generated = resolve(output, "worker/wrangler.json");
const environment = { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.account_id,
  RATATOSKR_CONFIG: snapshot, RATATOSKR_BUILD_DIRECTORY: output };
let publicationAttempted = false;
try {
  writeFileSync(snapshot, `${JSON.stringify(target, null, 2)}\n`, { flag: "wx" });
  mkdirSync(output, { recursive: true });
  run("bun", ["run", "build"], environment);
  validateGeneratedTarget(generated, target, output);
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
