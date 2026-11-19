import { z } from "zod";

export const applicationSummarySchema = z.object({ id: z.string(), name: z.string(), type: z.string().optional(), domain: z.string().optional(),
  self_hosted_domains: z.array(z.string()).optional(), destinations: z.array(z.object({ uri: z.string().optional(), type: z.string().optional(),
    // each override can make a matching path public, bypassing Access authentication.
    overrides: z.array(z.unknown()).nullish() }).passthrough()).optional() }).passthrough();
export const applicationSchema = applicationSummarySchema.extend({
  type: z.literal("self_hosted"), domain: z.string(), aud: z.string().min(1), allowed_idps: z.array(z.string()),
  policies: z.array(z.object({ decision: z.string(), include: z.array(z.unknown()), exclude: z.array(z.unknown()).optional(),
    // cloudflare returns null, or omits the key, for a duration that is not set.
    require: z.array(z.unknown()).optional(), session_duration: z.string().nullish() }).passthrough()),
  session_duration: z.string().nullish(),
  // overrides the organisation's setting of the same name when present.
  allow_authenticate_via_warp: z.boolean().nullish(),
  // true lets CORS preflight requests through without authentication.
  options_preflight_bypass: z.boolean().nullish(),
});
export const accessOrganisationSchema = z.object({
  auth_domain: z.string().endsWith(".cloudflareaccess.com"),
  allow_authenticate_via_warp: z.boolean().nullish(),
});
export const ACCESS_SESSION_DURATION = "8h";
// cloudflare documents 24h as the session duration of an application that does not set one.
const ACCESS_DEFAULT_SESSION_DURATION = "24h";
// the parser accepts a strict subset of Go durations (https://pkg.go.dev/time#ParseDuration) and fails closed on anything outside
// that subset, so a value this script cannot read is never mistaken for a short session. forms Go accepts but this rejects include
// "0", a leading sign ("+8h"), a bare trailing dot ("8.h") and a fraction of more than nine digits. arithmetic uses whole
// nanoseconds in BigInt, so whole components are exact and fractional nanoseconds are truncated exactly per component. Go converts
// a fraction through float64, which can round a fraction with very many digits differently, so a fraction is accepted only up to
// the nanosecond precision where the two agree.
const MAXIMUM_FRACTION_DIGITS = 9;
const nanosecondsPerUnit: Readonly<Record<string, bigint>> = {
  ns: 1n, us: 1_000n, "µs": 1_000n, "μs": 1_000n,
  ms: 1_000_000n, s: 1_000_000_000n, m: 60_000_000_000n, h: 3_600_000_000_000n,
};
const goDurationComponentPattern = /(\d+(?:\.\d+)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gy;
const DECIMAL_BASE = 10n;
const UNPARSABLE_SESSION_DURATION_MESSAGE = "Access application has an unparsable session duration.";
type Application = z.output<typeof applicationSchema>;
type Summary = z.output<typeof applicationSummarySchema>;
export type AccessOrganisation = z.output<typeof accessOrganisationSchema>;

function componentNanoseconds(amount: string, unit: string): bigint {
  const [whole = "", fraction = ""] = amount.split(".");
  if (fraction.length > MAXIMUM_FRACTION_DIGITS) throw new Error(UNPARSABLE_SESSION_DURATION_MESSAGE);
  const unitNanoseconds = nanosecondsPerUnit[unit]!;
  const wholeNanoseconds = BigInt(whole === "" ? "0" : whole) * unitNanoseconds;
  const fractionNanoseconds = BigInt(fraction === "" ? "0" : fraction) * unitNanoseconds / DECIMAL_BASE ** BigInt(fraction.length);
  return wholeNanoseconds + fractionNanoseconds;
}
function parseGoDurationNanoseconds(value: string): bigint {
  const components = [...value.matchAll(goDurationComponentPattern)];
  if (components.length === 0 || components.map((component) => component[0]).join("") !== value) {
    throw new Error(UNPARSABLE_SESSION_DURATION_MESSAGE);
  }
  return components.reduce((totalNanoseconds, [, amount, unit]) => totalNanoseconds + componentNanoseconds(amount!, unit!), 0n);
}
function normalise(value: string): string {
  const slash = value.indexOf("/");
  const host = (slash < 0 ? value : value.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? "" : value.slice(slash);
  return `${host}${path === "/" || path === "/*" ? "" : path}`;
}
function destinations(application: Summary): string[] {
  const legacy = application.self_hosted_domains?.length ? application.self_hosted_domains.map(normalise) : undefined;
  const modern = application.destinations?.length ? application.destinations.map((destination) => {
    if (!destination.uri || (destination.type && destination.type !== "public")) throw new Error("Unexpected Access destination.");
    return normalise(destination.uri);
  }) : undefined;
  if (legacy && modern && JSON.stringify([...legacy].sort()) !== JSON.stringify([...modern].sort())) {
    throw new Error("Conflicting Access destination representations.");
  }
  return modern ?? legacy ?? (application.domain ? [normalise(application.domain)] : []);
}
function publicDestinations(application: Summary): string[] {
  return [
    ...(application.domain ? [application.domain] : []),
    ...(application.self_hosted_domains ?? []),
    ...(application.destinations ?? []).flatMap((destination) =>
      destination.uri && (!destination.type || destination.type === "public") ? [destination.uri] : []),
  ].filter((destination) => destination.length > 0).map(normalise);
}
function overlaps(left: string, right: string): boolean {
  const split = (value: string): [string, string] => {
    const index = value.indexOf("/");
    return index < 0 ? [value, ""] : [value.slice(0, index), value.slice(index)];
  };
  const [leftHost, leftPath] = split(normalise(left));
  const [rightHost, rightPath] = split(normalise(right));
  const hostPattern = (pattern: string, host: string): boolean => {
    const expression = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^.]*");
    return new RegExp(`^${expression}$`).test(host);
  };
  const hostMatches = hostPattern(leftHost, rightHost) || hostPattern(rightHost, leftHost)
    || (leftHost.includes("*") && rightHost.includes("*"));
  if (!hostMatches) return false;
  const prefix = (path: string) => path.includes("*") ? path.slice(0, path.indexOf("*")) : path;
  const first = prefix(leftPath);
  const second = prefix(rightPath);
  if (leftPath.includes("*") || rightPath.includes("*")) {
    return !first || !second || first.startsWith(second) || second.startsWith(first);
  }
  return !first || !second || first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}
export function findExistingApplication(applications: Summary[], name: string, domain: string, required: string[]): Summary | undefined {
  const candidates = applications.filter((application) => application.name === name);
  if (candidates.length > 1) throw new Error("Multiple Access applications have the requested name.");
  const existing = candidates[0];
  for (const application of applications) {
    if (application.id === existing?.id) continue;
    if (publicDestinations(application).some((destination) => required.some((item) => overlaps(destination, item)))) {
      throw new Error("Another Access application overlaps the management paths.");
    }
  }
  if (existing && normalise(existing.domain ?? "") !== normalise(domain)) throw new Error("Access application domain differs from the requested domain.");
  return existing;
}
export function validateApplication(application: Application, name: string, domain: string, required: string[], provider: string, emails: string[],
  organisation: AccessOrganisation): void {
  const maximumSessionDurationNs = parseGoDurationNanoseconds(ACCESS_SESSION_DURATION);
  const applicationSessionDurationNs = parseGoDurationNanoseconds(application.session_duration ?? ACCESS_DEFAULT_SESSION_DURATION);
  // a policy's own session duration overrides the application's, so it is bounded by the same limit. null means no override.
  const policySessionDurationsNs = application.policies.map((policy) =>
    policy.session_duration == null ? null : parseGoDurationNanoseconds(policy.session_duration));
  if (policySessionDurationsNs.some((durationNs) => durationNs !== null && durationNs > maximumSessionDurationNs)) {
    throw new Error(`Access policy session duration exceeds ${ACCESS_SESSION_DURATION}.`);
  }
  // the application's duration still governs any policy without its own, so it only needs bounding when one exists.
  const applicationDurationApplies = policySessionDurationsNs.length === 0 || policySessionDurationsNs.includes(null);
  if (applicationDurationApplies && applicationSessionDurationNs > maximumSessionDurationNs) {
    throw new Error(`Access application session duration exceeds ${ACCESS_SESSION_DURATION}.`);
  }
  // when authentication through the Cloudflare One Client (WARP) is allowed, the client session takes precedence over the
  // application's session duration, so the bound above would not hold.
  if (application.allow_authenticate_via_warp ?? organisation.allow_authenticate_via_warp ?? false) {
    throw new Error("Access application allows authentication through the Cloudflare One Client, whose session takes precedence over the session duration.");
  }
  // a public destination's override can make a matching path public, so none may exist on the owned application.
  if (application.destinations?.some((destination) => (destination.overrides?.length ?? 0) > 0)) {
    throw new Error("Access application has a destination override, which can make a matching path public and bypass Access authentication.");
  }
  // the bypass answers CORS preflight requests without authentication.
  if (application.options_preflight_bypass === true) {
    throw new Error("Access application enables options_preflight_bypass, which lets preflight requests bypass Access authentication.");
  }
  const actual = destinations(application);
  const expected = required.map(normalise);
  const policy = application.policies[0];
  const selector = z.object({ email: z.object({ email: z.email() }).strict() }).strict();
  const parsed = policy?.include.map((rule) => selector.safeParse(rule));
  if (application.name !== name || normalise(application.domain) !== normalise(domain)
    || !actual.includes(normalise(domain)) || JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
    || application.allowed_idps.length !== 1 || application.allowed_idps[0] !== provider
    || application.policies.length !== 1 || policy?.decision !== "allow"
    || (policy.exclude?.length ?? 0) !== 0 || (policy.require?.length ?? 0) !== 0
    || !parsed || parsed.some((result) => !result.success)
    || JSON.stringify(parsed.flatMap((result) => result.success ? [result.data.email.email.toLowerCase()] : []).sort()) !== JSON.stringify([...emails].sort())) {
    throw new Error("Access application does not match the requested management protection.");
  }
}
