import { readDeploymentTarget } from "./deployment-configuration.ts";
import { deploymentRequest as request } from "./deployment-http.ts";
import { DEPLOYMENT_CONFIGURATION_PATH } from "./cloudflare.ts";
import {
  assertAccessAnswer, classifyManagementAnswer, describeManagementFailure, describeStrictTransportSecurityFailure, isUncachedResponse,
  isHealthyWorkerResponse, isHttpsRedirect,
} from "./deployment-probes.ts";

const target = readDeploymentTarget(process.env.RATATOSKR_CONFIG ?? DEPLOYMENT_CONFIGURATION_PATH);
const state = { shortOrigin: target.vars.SHORT_ORIGIN, adminOrigin: target.vars.ADMIN_ORIGIN,
  previewOrigin: target.vars.PREVIEW_ORIGIN, accessIssuer: target.vars.ACCESS_ISSUER,
  accessAudience: target.vars.ACCESS_AUDIENCE, databaseId: target.d1_databases[0].database_id };
process.env.CLOUDFLARE_ACCOUNT_ID = target.account_id;
const MAXIMUM_ATTEMPTS = 12;
const RETRY_DELAY_MS = 3000;
// the Worker once classified the raw path while its router matched the decoded one, so these must never reach the management API.
const ENCODED_MANAGEMENT_PATHS = ["/%61pi/links", "/%61pi/export", "/%61pi/settings", "/%61pi/session"];
const MANAGEMENT_API_PATHS = ["/api/links", "/api/export", "/api/settings", "/api/session"];
const HTTPS_UPGRADE_PATH = "/_health?verification=https-upgrade";
// consecutive hyphens never parse as a custom slug (parseCustomSlug in src/slugs.ts), so nobody can claim this path and turn the
// public 404 into a redirect. tests-node/operations-deploy.test.ts keeps that assumption checked against the slug source.
const UNKNOWN_SHORTLINK_PATH = "/verification--does-not-exist";
// nested routes under the management prefixes, to catch an Access destination that covers only the exact paths.
const NESTED_MANAGEMENT_PATHS = ["/api/links/verification-probe", "/api/links/verification-probe/image", "/assets/index.js"];

async function checkHealth(origin: string, label: string): Promise<void> {
  const health = await request(`${origin}/_health`);
  if (!(await isHealthyWorkerResponse(health))) {
    throw new Error(`${label} health returned ${health.status} without the Worker's {"status":"ok"} body.`);
  }
  const strictTransportSecurityFailure = describeStrictTransportSecurityFailure(label, health);
  if (strictTransportSecurityFailure !== null) throw new Error(strictTransportSecurityFailure);
}

// the query string proves the redirect keeps the whole request target rather than only the path.
async function checkHttpsUpgrade(origin: string): Promise<void> {
  const host = new URL(origin).host;
  const expectedLocation = `https://${host}${HTTPS_UPGRADE_PATH}`;
  const insecureHealth = await request(`http://${host}${HTTPS_UPGRADE_PATH}`);
  if (!isHttpsRedirect(insecureHealth, expectedLocation)) {
    throw new Error(`Plain HTTP health returned ${insecureHealth.status}; it must permanently redirect to ${expectedLocation}.`);
  }
}

// Cloudflare Access may answer plain HTTP on the admin hostname before the Worker can upgrade it, so its login redirect also passes.
async function checkAdminHttpUpgrade(origin: string): Promise<void> {
  const host = new URL(origin).host;
  const expectedLocation = `https://${host}${HTTPS_UPGRADE_PATH}`;
  const insecureHealth = await request(`http://${host}${HTTPS_UPGRADE_PATH}`);
  const requestUrl = `http://${host}${HTTPS_UPGRADE_PATH}`;
  const answer = await classifyManagementAnswer(insecureHealth, requestUrl, state.accessIssuer, state.accessAudience);
  // a challenge says nothing about either behaviour, even when it carries a redirect status.
  if (answer === "access-login" || (answer !== "edge-challenge" && isHttpsRedirect(insecureHealth, expectedLocation))) return;
  const challenge = answer === "edge-challenge" ? " with a cf-mitigated header from a WAF or bot challenge" : "";
  throw new Error(`Plain HTTP on the admin hostname returned ${insecureHealth.status}${challenge}; it must permanently redirect to ${expectedLocation} or reach the Cloudflare Access login.`);
}

const SUCCESS_STATUS_MINIMUM = 200;
const SUCCESS_STATUS_EXCLUSIVE_MAXIMUM = 300;

async function checkEncodedManagementPaths(origin: string): Promise<void> {
  for (const path of ENCODED_MANAGEMENT_PATHS) {
    const response = await request(`${origin}${path}`);
    if (response.status === 404) continue;
    if (response.status >= SUCCESS_STATUS_MINIMUM && response.status < SUCCESS_STATUS_EXCLUSIVE_MAXIMUM) {
      throw new Error(`${origin}${path} returned ${response.status}, so the Worker served data for an encoded management path. It must return 404.`);
    }
    await assertAccessAnswer(`${origin}${path}`, response, state.accessIssuer, state.accessAudience,
      " Encoded management paths must be 404 or answered by Cloudflare Access.");
  }
}

// the management API belongs only to the admin hostname, so every other hostname of the Worker must not route these paths.
async function checkManagementPathsAbsent(origin: string, label: string): Promise<void> {
  for (const path of MANAGEMENT_API_PATHS) {
    const response = await request(`${origin}${path}`);
    if (response.status !== 404) throw new Error(`Management API path ${origin}${path} returned ${response.status}; it must not be exposed on the ${label} hostname.`);
  }
}

async function checkAccessCoverage(): Promise<void> {
  const sharedHostname = state.adminOrigin === state.shortOrigin;
  const privateUrl = sharedHostname ? `${state.adminOrigin}/admin/` : state.adminOrigin;
  const failure = await describeManagementFailure(privateUrl, await request(privateUrl), state.accessIssuer, state.accessAudience);
  if (failure !== null) throw new Error(`The admin panel must redirect unauthenticated requests to Cloudflare Access. ${failure}`);
  const protectedPaths = [...MANAGEMENT_API_PATHS, "/assets/", ...NESTED_MANAGEMENT_PATHS];
  for (const path of protectedPaths) {
    await assertAccessAnswer(`${state.adminOrigin}${path}`, await request(`${state.adminOrigin}${path}`), state.accessIssuer, state.accessAudience, " Access must cover this path at the edge.");
  }
}

async function checkDeployment(): Promise<void> {
  await checkHealth(state.shortOrigin, "Public");
  await checkHttpsUpgrade(state.shortOrigin);
  const unavailable = await request(`${state.shortOrigin}${UNKNOWN_SHORTLINK_PATH}`);
  if (unavailable.status !== 404 || !isUncachedResponse(unavailable)) {
    throw new Error("Unknown shortlinks must return an uncached 404.");
  }
  await checkAccessCoverage();
  if (state.adminOrigin !== state.shortOrigin) {
    await checkAdminHttpUpgrade(state.adminOrigin);
    await checkManagementPathsAbsent(state.shortOrigin, "public");
    // the admin hostname is the one that serves the API, so a decoded-path bug there is the most serious.
    await checkEncodedManagementPaths(state.adminOrigin);
  }
  await checkEncodedManagementPaths(state.shortOrigin);
  if (state.previewOrigin) {
    const preview = await request(`${state.previewOrigin}${UNKNOWN_SHORTLINK_PATH}`);
    if (preview.status !== 404) throw new Error("Preview hostname is not routed to the application.");
    if (!isUncachedResponse(preview)) throw new Error("Unknown shortlinks on the preview hostname must return an uncached 404.");
    await checkHealth(state.previewOrigin, "Preview");
    await checkManagementPathsAbsent(state.previewOrigin, "preview");
    await checkEncodedManagementPaths(state.previewOrigin);
    await checkHttpsUpgrade(state.previewOrigin);
  }
}

for (let attemptCount = 1; attemptCount <= MAXIMUM_ATTEMPTS; attemptCount += 1) {
  try {
    await checkDeployment();
    console.info(`Verified public routing, HTTPS enforcement, uncached misses, encoded-path handling and Access protection at ${state.shortOrigin}.`);
    console.info("Complete the authenticated create/edit/revoke/delete flow in the admin panel to verify your login.");
    break;
  } catch (error) {
    if (attemptCount === MAXIMUM_ATTEMPTS) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}
