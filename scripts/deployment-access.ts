import { z } from "zod";

export const applicationSummarySchema = z.object({ id: z.string(), name: z.string(), type: z.string().optional(), domain: z.string().optional(),
  self_hosted_domains: z.array(z.string()).optional(), destinations: z.array(z.object({ uri: z.string().optional(), type: z.string().optional() }).passthrough()).optional() }).passthrough();
export const applicationSchema = applicationSummarySchema.extend({
  type: z.literal("self_hosted"), domain: z.string(), aud: z.string().min(1), allowed_idps: z.array(z.string()),
  policies: z.array(z.object({ decision: z.string(), include: z.array(z.unknown()), exclude: z.array(z.unknown()).optional(), require: z.array(z.unknown()).optional() }).passthrough()),
});
type Application = z.output<typeof applicationSchema>;
type Summary = z.output<typeof applicationSummarySchema>;

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
export function validateApplication(application: Application, name: string, domain: string, required: string[], provider: string, emails: string[]): void {
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
