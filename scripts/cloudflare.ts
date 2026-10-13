import { execFileSync } from "node:child_process";
import { z } from "zod";

export const DEPLOYMENT_CONFIGURATION_PATH = "wrangler.deploy.json";
export const DEPLOYMENT_STATE_PATH = "deployment-state.json";
const MAXIMUM_CLI_OUTPUT_BYTES = 4 * 1024 * 1024;

export const deploymentStateSchema = z.object({
  accountId: z.string(), zoneId: z.string(), workerName: z.string(), databaseId: z.string(),
  applicationId: z.string(), identityProviderId: z.string(), accessAudience: z.string(),
  shortOrigin: z.url(), adminOrigin: z.url(), previewOrigin: z.url().nullable(),
  accessIssuer: z.url(), administratorEmails: z.array(z.email()),
});

export type DeploymentState = z.infer<typeof deploymentStateSchema>;

export function cloudflare<Schema extends z.ZodType>(arguments_: readonly string[], schema: Schema): z.output<Schema> {
  const output = execFileSync(process.env.CF_EXECUTABLE ?? "cf", [...arguments_], {
    encoding: "utf8", env: process.env, maxBuffer: MAXIMUM_CLI_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const response: unknown = JSON.parse(output);
  return schema.parse(response);
}

export function run(command: string, arguments_: readonly string[], environment = process.env): void {
  execFileSync(command, [...arguments_], { env: environment, stdio: "inherit" });
}
