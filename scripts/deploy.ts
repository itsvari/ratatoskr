import { readFileSync } from "node:fs";
import { deploymentStateSchema, DEPLOYMENT_STATE_PATH, run } from "./cloudflare.ts";

const state = deploymentStateSchema.parse(JSON.parse(readFileSync(DEPLOYMENT_STATE_PATH, "utf8")));
const environment = {
  ...process.env, CLOUDFLARE_ACCOUNT_ID: state.accountId, RATATOSKR_CONFIG: "../wrangler.deploy.json",
};
run(process.env.CF_EXECUTABLE ?? "cf", ["d1", "migrations", "apply", state.databaseId, "--dir", "migrations"], environment);
run("bun", ["run", "build"], environment);
run("bun", ["x", "wrangler", "deploy", "--config", `dist/${state.workerName}/wrangler.json`], environment);
run("node", ["scripts/verify-deployment.ts"], environment);
