import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const originSchema = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
const configurationSchema = z.object({
  name: z.string().min(1), account_id: z.string().min(1), main: z.string().min(1),
  assets: z.object({ directory: z.string().min(1) }).passthrough(),
  vars: z.object({
    SHORT_ORIGIN: originSchema, ADMIN_ORIGIN: originSchema,
    PREVIEW_ORIGIN: z.union([originSchema, z.literal("")]), ACCESS_ISSUER: originSchema,
    ACCESS_AUDIENCE: z.string().min(1), ADMIN_EMAILS: z.string().min(1).refine((value) =>
      value.split(",").every((email) => z.email().safeParse(email).success)),
  }).passthrough(),
  routes: z.array(z.object({ pattern: z.string().min(1), custom_domain: z.boolean() }).passthrough()),
  d1_databases: z.tuple([z.object({ binding: z.literal("DB"), database_name: z.string().min(1),
    database_id: z.string().min(1), migrations_dir: z.string().min(1) }).passthrough()]),
}).passthrough().refine((configuration) => {
  const { SHORT_ORIGIN: shortOrigin, ADMIN_ORIGIN: adminOrigin, PREVIEW_ORIGIN: previewOrigin, ACCESS_ISSUER: issuer } = configuration.vars;
  return !Object.hasOwn(configuration.vars, "LOCAL_DEVELOPMENT")
    && new URL(issuer).hostname.endsWith(".cloudflareaccess.com")
    && (!previewOrigin || (previewOrigin !== shortOrigin && previewOrigin !== adminOrigin));
}, "Invalid deployment origins or local authentication configuration.");
export type DeploymentTarget = z.output<typeof configurationSchema>;

export function readDeploymentTarget(path: string): DeploymentTarget {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return configurationSchema.parse(value);
}

export function atomicWrite(path: string, contents: string): void {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

export function validateGeneratedTarget(path: string, captured: DeploymentTarget, output: string): void {
  const generated = readDeploymentTarget(path);
  const database = generated.d1_databases[0];
  const expectedDatabase = captured.d1_databases[0];
  if (generated.name !== captured.name || generated.account_id !== captured.account_id
    || database.database_id !== expectedDatabase.database_id || database.database_name !== expectedDatabase.database_name
    || generated.routes.length !== captured.routes.length
    || captured.routes.some((route) => generated.routes.filter((candidate) => isDeepStrictEqual(candidate, route)).length
      !== captured.routes.filter((candidate) => isDeepStrictEqual(candidate, route)).length)
    || Object.keys(generated.vars).length !== Object.keys(captured.vars).length
    || Object.entries(captured.vars).some(([key, value]) => !Object.hasOwn(generated.vars, key)
      || JSON.stringify(generated.vars[key]) !== JSON.stringify(value))) {
    throw new Error("Generated deployment target differs from the captured configuration.");
  }
  for (const pathValue of [generated.main, generated.assets.directory]) {
    const resolved = resolve(dirname(path), pathValue);
    const within = relative(output, resolved);
    if (!within || within.startsWith("..") || isAbsolute(within)) throw new Error("Generated paths must remain inside the deployment output.");
  }
}
