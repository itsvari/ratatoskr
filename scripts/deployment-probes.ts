import { z } from "zod";

// mirrors the management rejections in src/index.ts. scripts run under Node type stripping and cannot import src/ or shared/,
// so tests-node/operations-deploy.test.ts checks that these messages still exist in the Worker source.
export const WORKER_UNAUTHENTICATED_MESSAGE = "Sign in through Cloudflare Access to continue.";
export const WORKER_FORBIDDEN_ORIGIN_MESSAGE = "This request must come from the admin panel.";
const WORKER_REJECTION_MESSAGES: readonly string[] = [WORKER_UNAUTHENTICATED_MESSAGE, WORKER_FORBIDDEN_ORIGIN_MESSAGE];
const ACCESS_REDIRECT_STATUS = 302;
const ACCESS_LOGIN_PATH_PREFIX = "/cdn-cgi/access/login/";
const WORKER_REJECTION_STATUSES: readonly number[] = [401, 403];
// both statuses are permanent: 308 is the Worker's own upgrade and 301 is the Cloudflare edge's "Always Use HTTPS" redirect.
// a temporary redirect would not let browsers and crawlers remember the secure location.
const PERMANENT_HTTPS_REDIRECT_STATUSES: readonly number[] = [301, 308];
// mirrors HSTS_MAX_AGE_SECONDS in src/index.ts, which tests-node/operations-deploy.test.ts checks against the Worker source.
const MINIMUM_HSTS_MAX_AGE_SECONDS = 31_536_000n;
const hstsMaximumAgePattern = /^(?:\d+|"\d+")$/;
// RFC 7230 section 3.2.6 token characters, which is what RFC 6797 requires of a directive name.
const hstsDirectiveNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ACCESS_APPLICATION_AUDIENCE_PARAMETER = "kid";
const workerRejectionSchema = z.object({ error: z.string() }).passthrough();
const healthBodySchema = z.object({ status: z.literal("ok") }).strict();

export type ManagementAnswer = "access-login" | "other-access-application" | "worker-rejection" | "edge-challenge" | "inconclusive";
type AccessLoginRedirect = "none" | "this-application" | "other-application";

async function isWorkerRejection(response: Response): Promise<boolean> {
  if (!WORKER_REJECTION_STATUSES.includes(response.status)) return false;
  let body: unknown;
  try { body = JSON.parse(await response.text()); } catch { return false; }
  const parsed = workerRejectionSchema.safeParse(body);
  return parsed.success && WORKER_REJECTION_MESSAGES.includes(parsed.data.error);
}

// only the login redirect of this deployment's Access application proves that Access answered at the edge. a generic 401 or 403
// could be a WAF rule, an origin firewall or another application, and a redirect elsewhere on the team domain is not the login
// flow. cloudflare's own Access plugin builds the login url as "<team origin>/cdn-cgi/access/login/<hostname>?kid=<application AUD>",
// so the path is bound to the requested hostname and a redirect from another application on the same team differs only in its kid.
// the redirect_url parameter is not validated because its live format is unconfirmed. a login that is missing the kid, carries
// it more than once or leaves it empty says nothing about which application answered, so it stays inconclusive rather than naming
// another application.
function classifyAccessLoginRedirect(response: Response, requestUrl: string, accessIssuer: string, accessAudience: string): AccessLoginRedirect {
  if (response.status !== ACCESS_REDIRECT_STATUS) return "none";
  const location = response.headers.get("Location");
  if (location === null) return "none";
  // repeated Location fields are joined with a comma. the probe paths and the login url's own parameters (kid, an encoded
  // redirect_url, meta) contain none, so a comma means the field boundaries are unknown and the answer is inconclusive.
  if (location.includes(",")) return "none";
  let target: URL;
  try { target = new URL(location); } catch { return "none"; }
  if (target.origin !== new URL(accessIssuer).origin || !target.pathname.startsWith(ACCESS_LOGIN_PATH_PREFIX)) return "none";
  const expectedPath = `${ACCESS_LOGIN_PATH_PREFIX}${new URL(requestUrl).hostname}`;
  if (target.pathname.toLowerCase() !== expectedPath.toLowerCase()) return "none";
  const audiences = target.searchParams.getAll(ACCESS_APPLICATION_AUDIENCE_PARAMETER);
  const [audience] = audiences;
  // an empty kid carries no application identity, so it cannot be told apart from a missing one.
  if (audiences.length !== 1 || audience === undefined || audience.trim() === "") return "none";
  return audience === accessAudience ? "this-application" : "other-application";
}

export async function classifyManagementAnswer(response: Response, requestUrl: string, accessIssuer: string, accessAudience: string): Promise<ManagementAnswer> {
  // WAF rules and bot challenges also answer at the edge, so a mitigated response says nothing about Access coverage.
  if (response.headers.has("cf-mitigated")) return "edge-challenge";
  const login = classifyAccessLoginRedirect(response, requestUrl, accessIssuer, accessAudience);
  if (login === "this-application") return "access-login";
  if (login === "other-application") return "other-access-application";
  return (await isWorkerRejection(response)) ? "worker-rejection" : "inconclusive";
}

// a management path is protected only when Cloudflare Access answered at the edge. the Worker's own 401 proves nothing
// about the Access application's path coverage, because the Worker would send it for a request Access let through.
export async function describeManagementFailure(url: string, response: Response, accessIssuer: string, accessAudience: string): Promise<string | null> {
  const answer = await classifyManagementAnswer(response, url, accessIssuer, accessAudience);
  if (answer === "access-login") return null;
  if (answer === "other-access-application") {
    return `Another Access application answered ${url} with a login redirect whose ${ACCESS_APPLICATION_AUDIENCE_PARAMETER} is not this deployment's ACCESS_AUDIENCE, `
      + "so this deployment's Access application does not cover the path.";
  }
  if (answer === "worker-rejection") {
    return `${url} returned ${response.status} from the Worker, so Access does not cover this path at the edge.`;
  }
  if (answer === "edge-challenge") {
    return `${url} returned ${response.status} with a cf-mitigated header from a WAF or bot challenge, which says nothing about Access coverage.`;
  }
  return `${url} returned ${response.status} without an Access login redirect to ${new URL(accessIssuer).origin}${ACCESS_LOGIN_PATH_PREFIX}${new URL(url).hostname}; `
    + "confirm the Access application's destinations in the Cloudflare dashboard.";
}

export async function assertAccessAnswer(url: string, response: Response, accessIssuer: string, accessAudience: string, consequence = ""): Promise<void> {
  const failure = await describeManagementFailure(url, response, accessIssuer, accessAudience);
  if (failure !== null) throw new Error(`${failure}${consequence}`);
}

// RFC 7230 section 3.2.3 optional whitespace is only space and horizontal tab. String.prototype.trim also removes Unicode
// whitespace such as a no-break space, which would make a malformed value look valid.
function trimOptionalWhitespace(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, "");
}

// splits on a separator that is outside quoted strings, honouring the backslash escapes of RFC 7230 quoted-pair.
function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let insideQuotes = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (insideQuotes && character === "\\" && index + 1 < value.length) {
      current += character + value[index + 1]!;
      index += 1;
      continue;
    }
    if (character === '"') insideQuotes = !insideQuotes;
    if (character === separator && !insideQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

// RFC 7230 section 3.2.6 quoted-string: DQUOTE *( qdtext / quoted-pair ) DQUOTE.
const quotedStringPattern = /^"(?:[\t \x21\x23-\x5B\x5D-\x7E\x80-\xFF]|\\[\t \x21-\x7E\x80-\xFF])*"$/;
// RFC 6797 defines these two directives without a value.
const VALUELESS_HSTS_DIRECTIVES: ReadonlySet<string> = new Set(["includesubdomains", "preload"]);
const HSTS_MAXIMUM_AGE_DIRECTIVE = "max-age";

export type StrictTransportSecurityVerdict = "valid" | "invalid" | "multiple-or-malformed-fields";

function isValidHstsDirective(directive: string, seenNames: Set<string>): { readonly valid: boolean; readonly maximumAge?: string } {
  const separatorIndex = directive.indexOf("=");
  const rawName = trimOptionalWhitespace(separatorIndex < 0 ? directive : directive.slice(0, separatorIndex));
  if (!hstsDirectiveNamePattern.test(rawName)) return { valid: false };
  const name = rawName.toLowerCase();
  if (seenNames.has(name)) return { valid: false };
  seenNames.add(name);
  if (separatorIndex < 0) return { valid: name !== HSTS_MAXIMUM_AGE_DIRECTIVE };
  const value = trimOptionalWhitespace(directive.slice(separatorIndex + 1));
  const valueIsTokenOrQuotedString = hstsDirectiveNamePattern.test(value) || quotedStringPattern.test(value);
  if (!valueIsTokenOrQuotedString || VALUELESS_HSTS_DIRECTIVES.has(name)) return { valid: false };
  return name === HSTS_MAXIMUM_AGE_DIRECTIVE ? { valid: hstsMaximumAgePattern.test(value), maximumAge: value } : { valid: true };
}

// follows RFC 6797: ";"-separated directives, case-insensitive token names, optional whitespace around "=", no directive more than
// once, a value that is a token or quoted string and absent for the valueless directives, and a max-age that is digits or a quoted
// string of digits. any deviation makes the whole field invalid, and browsers then ignore it. Headers.get joins repeated fields with
// ", " and the field boundaries cannot be recovered, so two malformed fields can join into text that looks valid, for example
// 'max-age="31536000' and '"' becoming 'max-age="31536000, "'. a legitimate single field from the Worker or Cloudflare never contains
// a comma, quoted or not, so any comma is rejected as ambiguous rather than risking a joined pair that passes.
export function classifyStrictTransportSecurity(response: Response): StrictTransportSecurityVerdict {
  const header = response.headers.get("Strict-Transport-Security");
  if (header === null) return "invalid";
  if (header.includes(",")) return "multiple-or-malformed-fields";
  const seenNames = new Set<string>();
  let maximumAge: string | undefined;
  for (const rawDirective of splitOutsideQuotes(header, ";")) {
    const directive = trimOptionalWhitespace(rawDirective);
    if (directive === "") continue;
    const inspected = isValidHstsDirective(directive, seenNames);
    if (!inspected.valid) return "invalid";
    maximumAge = inspected.maximumAge ?? maximumAge;
  }
  if (maximumAge === undefined) return "invalid";
  return BigInt(maximumAge.replaceAll('"', "")) >= MINIMUM_HSTS_MAX_AGE_SECONDS ? "valid" : "invalid";
}

export function describeStrictTransportSecurityFailure(label: string, response: Response): string | null {
  const verdict = classifyStrictTransportSecurity(response);
  if (verdict === "valid") return null;
  if (verdict === "multiple-or-malformed-fields") {
    return `${label} health carries more than one Strict-Transport-Security field, or a malformed one, and must carry exactly one valid field with a max-age of at least one year.`;
  }
  return `${label} health must send a valid Strict-Transport-Security header with a max-age of at least one year.`;
}

const NO_STORE_DIRECTIVE = "no-store";
// a cache that implements the status code's requirements may store a response that carries this directive, even with no-store.
const MUST_UNDERSTAND_DIRECTIVE = "must-understand";

// these statuses and any Age header show that a cache held or reused a stored copy. MISS, BYPASS, DYNAMIC and EXPIRED mean the
// response came from the origin on this request, so they are not evidence of a cached answer and stay acceptable.
const CACHE_HIT_STATUSES: ReadonlySet<string> = new Set(["HIT", "STALE", "REVALIDATED", "UPDATING"]);

function showsCacheHit(response: Response): boolean {
  if (response.headers.has("Age")) return true;
  const cacheStatus = response.headers.get("CF-Cache-Status");
  return cacheStatus !== null && CACHE_HIT_STATUSES.has(trimOptionalWhitespace(cacheStatus).toUpperCase());
}

// a response is uncached only when its Cache-Control carries a bare no-store directive, because no-store="off" is not the
// directive the HTTP caching specification defines. other directives such as private may accompany it, but must-understand lets a
// cache store the response despite no-store, so it fails the check in any form. explicit cache-hit evidence fails it as well,
// because a cache can serve a stored copy that carries no-store.
export function isUncachedResponse(response: Response): boolean {
  if (showsCacheHit(response)) return false;
  const header = response.headers.get("Cache-Control");
  if (header === null) return false;
  let bareNoStore = false;
  for (const rawDirective of splitOutsideQuotes(header, ",")) {
    const directive = trimOptionalWhitespace(rawDirective);
    const separatorIndex = directive.indexOf("=");
    const name = trimOptionalWhitespace(separatorIndex < 0 ? directive : directive.slice(0, separatorIndex)).toLowerCase();
    if (name === MUST_UNDERSTAND_DIRECTIVE) return false;
    if (name !== NO_STORE_DIRECTIVE) continue;
    if (separatorIndex >= 0) return false;
    bareNoStore = true;
  }
  return bareNoStore;
}

export async function isHealthyWorkerResponse(response: Response): Promise<boolean> {
  if (response.status !== 200) return false;
  try { return healthBodySchema.safeParse(JSON.parse(await response.text())).success; } catch { return false; }
}

export function isHttpsRedirect(response: Response, expectedLocation: string): boolean {
  return PERMANENT_HTTPS_REDIRECT_STATUSES.includes(response.status) && response.headers.get("Location") === expectedLocation;
}
