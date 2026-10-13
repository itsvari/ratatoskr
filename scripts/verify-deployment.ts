import { readFileSync } from "node:fs";
import { deploymentRequest as request } from "./deployment-http.ts";
import { deploymentStateSchema, DEPLOYMENT_STATE_PATH } from "./cloudflare.ts";

const state = deploymentStateSchema.parse(JSON.parse(readFileSync(DEPLOYMENT_STATE_PATH, "utf8")));
const MAXIMUM_ATTEMPTS = 12;
const RETRY_DELAY_MS = 3000;

async function checkDeployment(): Promise<void> {
  const publicHealth = await request(`${state.shortOrigin}/_health`);
  if (!publicHealth.ok) throw new Error(`Public health returned ${publicHealth.status}.`);
  const unavailable = await request(`${state.shortOrigin}/verification-does-not-exist`);
  if (unavailable.status !== 404 || unavailable.headers.get("Cache-Control") !== "no-store") {
    throw new Error("Unknown shortlinks must return an uncached 404.");
  }
  const privateUrl = state.adminOrigin === state.shortOrigin ? `${state.adminOrigin}/admin/` : state.adminOrigin;
  const privateResponse = await request(privateUrl);
  const accessLocation = privateResponse.headers.get("Location");
  if (privateResponse.status !== 302 || !accessLocation?.startsWith(`${state.accessIssuer}/`)) {
    throw new Error("The admin panel must redirect unauthenticated requests to Cloudflare Access.");
  }
  const privateApi = await request(`${state.adminOrigin}/api/links`);
  if (![302, 401, 403].includes(privateApi.status)) throw new Error("Unauthenticated management API is exposed.");
  if (state.adminOrigin !== state.shortOrigin) {
    const alternateApi = await request(`${state.shortOrigin}/api/links`);
    if (alternateApi.status !== 404) throw new Error("Management API must not be exposed on the public hostname.");
  }
  if (state.previewOrigin) {
    const preview = await request(`${state.previewOrigin}/verification-does-not-exist`);
    if (preview.status !== 404) throw new Error("Preview hostname is not routed to the application.");
  }
}

for (let attemptCount = 1; attemptCount <= MAXIMUM_ATTEMPTS; attemptCount += 1) {
  try {
    await checkDeployment();
    console.info(`Verified public routing, uncached misses and Access protection at ${state.shortOrigin}.`);
    console.info("Complete the authenticated create/edit/revoke/delete flow in the admin panel to verify your login.");
    break;
  } catch (error) {
    if (attemptCount === MAXIMUM_ATTEMPTS) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}
