import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { atomicWrite } from "./deployment-configuration.ts";
import { applicationSchema, applicationSummarySchema, findExistingApplication, validateApplication } from "./deployment-access.ts";
import { cloudflare, DEPLOYMENT_CONFIGURATION_PATH, DEPLOYMENT_STATE_PATH, deploymentStateSchema } from "./cloudflare.ts";

const { values } = parseArgs({ options: {
  domain: { type: "string" }, name: { type: "string", default: "ratatoskr" }, email: { type: "string" },
  "account-id": { type: "string" }, "admin-subdomain": { type: "boolean", default: false },
  "preview-subdomain": { type: "boolean", default: false },
} });

const domain = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/).parse(values.domain?.toLowerCase());
const workerName = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/).parse(values.name);
const identity = cloudflare(["auth", "whoami"], z.object({
  authenticated: z.literal(true), email: z.email(), accounts: z.array(z.object({ id: z.string(), name: z.string() })),
}));
const accountId = values["account-id"] ?? (identity.accounts.length === 1 ? identity.accounts[0]?.id : undefined);
if (!accountId || !identity.accounts.some((account) => account.id === accountId)) {
  throw new Error("Select an authenticated account with --account-id.");
}
process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
const administratorEmails = (values.email ?? identity.email).split(",").map((email) => z.email().parse(email.trim().toLowerCase()));
const zones = cloudflare(["zones", "list", "--name", domain, "--account-id", accountId], z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })));
const zone = zones.find((candidate) => candidate.name === domain && candidate.status === "active");
if (!zone) throw new Error("The requested domain must be an active zone in the selected account.");
const organisation = cloudflare(["zero-trust", "organization", "get"], z.object({ auth_domain: z.string().endsWith(".cloudflareaccess.com") }));
const shortOrigin = `https://${domain}`;
const adminOrigin = values["admin-subdomain"] ? `https://admin.${domain}` : shortOrigin;
const previewOrigin = values["preview-subdomain"] ? `https://preview.${domain}` : null;
const providerSchema = z.object({ id: z.string(), type: z.string(), config: z.object({ restrict_to_account_members: z.boolean().optional() }).passthrough() });

const applicationName = `${workerName} admin`;
const applicationDomain = values["admin-subdomain"] ? `admin.${domain}` : `${domain}/admin`;
const domains = values["admin-subdomain"] ? [applicationDomain] : [`${domain}/admin`, `${domain}/api`, `${domain}/assets`];
const applications = cloudflare(["zero-trust", "access", "applications", "list"], z.array(applicationSummarySchema));
const inspectedApplications = applications.map((application) =>
  cloudflare(["zero-trust", "access", "applications", "get", application.id], applicationSummarySchema));
const existing = findExistingApplication(inspectedApplications, applicationName, applicationDomain, domains);
const providers = cloudflare(["zero-trust", "identity-providers", "list"], z.array(providerSchema));
const identityProvider = providers.find((provider) => provider.type === "cloudflare" && provider.config.restrict_to_account_members === true)
  ?? cloudflare(["zero-trust", "identity-providers", "create", "--body", JSON.stringify({
    name: "Ratatoskr — Cloudflare account", type: "cloudflare", config: { restrict_to_account_members: true },
  })], providerSchema);

const application = existing
  ? cloudflare(["zero-trust", "access", "applications", "get", existing.id], applicationSchema)
  : cloudflare(["zero-trust", "access", "applications", "create", "--body", JSON.stringify({
    name: applicationName, domain: applicationDomain, type: "self_hosted", self_hosted_domains: domains,
    session_duration: "8h", allowed_idps: [identityProvider.id], auto_redirect_to_identity: true,
    policies: [{ name: "Administrators", decision: "allow", include: administratorEmails.map((email) => ({ email: { email } })) }],
  })], applicationSchema);
validateApplication(application, applicationName, applicationDomain, domains, identityProvider.id, administratorEmails);

const databases = cloudflare(["d1", "list"], z.array(z.object({ uuid: z.string(), name: z.string() })));
const database = databases.find((candidate) => candidate.name === workerName)
  ?? cloudflare(["d1", "create", "--name", workerName, "--read-replication-mode", "disabled"], z.object({ uuid: z.string(), name: z.string() }));
const state = deploymentStateSchema.parse({
  accountId, zoneId: zone.id, workerName, databaseId: database.uuid, applicationId: application.id,
  identityProviderId: identityProvider.id, accessAudience: application.aud,
  shortOrigin, adminOrigin, previewOrigin, accessIssuer: `https://${organisation.auth_domain}`, administratorEmails,
});
const configuration: unknown = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
const parsedConfiguration = z.object({}).passthrough().parse(configuration);
const deploymentConfiguration = {
  ...parsedConfiguration, name: workerName, account_id: accountId,
  routes: [...new Set([shortOrigin, adminOrigin, previewOrigin].filter((origin) => origin !== null))]
    .map((origin) => ({ pattern: new URL(origin).hostname, custom_domain: true })),
  vars: {
    SHORT_ORIGIN: shortOrigin, ADMIN_ORIGIN: adminOrigin, PREVIEW_ORIGIN: previewOrigin ?? "",
    ACCESS_ISSUER: state.accessIssuer, ACCESS_AUDIENCE: state.accessAudience,
    ADMIN_EMAILS: administratorEmails.join(","),
  },
  d1_databases: [{ binding: "DB", database_name: workerName, database_id: database.uuid, migrations_dir: "migrations" }],
};
atomicWrite(DEPLOYMENT_CONFIGURATION_PATH, `${JSON.stringify(deploymentConfiguration, null, 2)}\n`);
atomicWrite(DEPLOYMENT_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
console.info(`Configured ${shortOrigin}; administration at ${values["admin-subdomain"] ? adminOrigin : `${adminOrigin}/admin/`}.`);
console.info("Access and D1 are ready. Run bun run deploy to apply migrations and publish.");
