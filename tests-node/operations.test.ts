import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseProfileTitle } from "../scripts/preview-profile-title.ts";
import { accessOrganisationSchema, applicationSchema, findExistingApplication, validateApplication, type AccessOrganisation } from "../scripts/deployment-access.ts";

const domains = ["example.com/admin", "example.com/api", "example.com/assets"];
const application = {
  id: "id", name: "links admin", type: "self_hosted", domain: domains[0], aud: "audience", allowed_idps: ["provider"], session_duration: "8h",
  self_hosted_domains: domains, policies: [{ decision: "allow", include: [{ email: { email: "admin@example.com" } }], exclude: [], require: [] }],
};
function organisationAllowingWarp(allowWarp?: boolean | null): AccessOrganisation {
  return accessOrganisationSchema.parse({ auth_domain: "team.cloudflareaccess.com", allow_authenticate_via_warp: allowWarp });
}
function validate(value: unknown, organisation: AccessOrganisation = organisationAllowingWarp()): void {
  validateApplication(applicationSchema.parse(value), "links admin", domains[0]!, domains, "provider", ["admin@example.com"], organisation);
}
test("Access requires all destinations and an exact policy", () => {
  validate(application);
  assert.throws(() => validate({ ...application, self_hosted_domains: domains.slice(0, 1) }));
  assert.throws(() => validate({ ...application, policies: [{ ...application.policies[0], exclude: [{ everyone: {} }] }] }));
  assert.throws(() => validate({ ...application, destinations: [{ type: "public", uri: domains[0] }] }));
  validate({ ...application, destinations: domains.map((uri) => ({ type: "public", uri })) });
});
test("overlapping applications fail while unrelated non-domain applications remain valid", () => {
  assert.equal(findExistingApplication([{ id: "other", name: "ssh", type: "ssh" }], "links admin", domains[0]!, domains), undefined);
  assert.throws(() => findExistingApplication([{ id: "other", name: "other", domain: "example.com/api/*" }], "links admin", domains[0]!, domains));
});

test("modern and legacy destinations reject private, inconsistent and insufficient coverage", () => {
  validate({ ...application, self_hosted_domains: undefined, destinations: domains.map((uri) => ({ type: "public", uri })) });
  assert.throws(() => validate({ ...application, self_hosted_domains: undefined, destinations: domains.map((uri) => ({ type: "private", uri })) }));
  assert.throws(() => validate({ ...application, self_hosted_domains: ["example.com/admin/*", ...domains.slice(1)] }));
  assert.throws(() => validate({ ...application, self_hosted_domains: ["example.com/Admin", ...domains.slice(1)] }));
  assert.throws(() => validate({ ...application, policies: [{ ...application.policies[0], require: [{ group: { id: "extra" } }] }] }));
});
test("overlap detection keeps path case and considers broader and more specific paths", () => {
  for (const domain of ["*.example.com", "example.com", "example.com/admin/*", "example.com/admin/deep"]) {
    const required = domain.startsWith("*.") ? ["admin.example.com"] : domains;
    assert.throws(() => findExistingApplication([{ id: "other", name: "other", domain }], "links admin", domains[0]!, required));
  }
  assert.equal(findExistingApplication([{ id: "other", name: "other", domain: "example.com/Admin" }], "links admin", domains[0]!, domains), undefined);
});

test("empty representations are ignored and partial wildcards overlap conservatively", () => {
  validate({ ...application, destinations: [] });
  validate({ ...application, self_hosted_domains: [], destinations: domains.map((uri) => ({ type: "public", uri })) });
  for (const domain of ["*admin.example.com", "example.com/a*"]) {
    const required = domain.startsWith("*") ? ["myadmin.example.com"] : domains;
    assert.throws(() => findExistingApplication([{ id: "other", name: "other", domain }], "links admin", domains[0]!, required));
  }
  assert.equal(findExistingApplication([{ id: "other", name: "other", domain: "example.com/public*" }], "links admin", domains[0]!, domains), undefined);
});

test("literal path siblings do not overlap management paths", () => {
  for (const domain of ["example.com/apiary", "example.com/administrator", "example.com/assets-old"]) {
    assert.equal(findExistingApplication([{ id: "other", name: "other", domain }], "links admin", domains[0]!, domains), undefined);
  }
  assert.throws(() => findExistingApplication([{ id: "other", name: "other", domain: "example.com/api/child" }], "links admin", domains[0]!, domains));
});

test("other applications project public destinations across types", () => {
  const unrelated = { id: "other", name: "other", type: "self_hosted", destinations: [
    { type: "private", uri: "example.com/api" }, { type: "private" }, { type: "public", uri: "other.example.com" },
  ] };
  assert.equal(findExistingApplication([unrelated], "links admin", domains[0]!, domains), undefined);
  assert.throws(() => findExistingApplication([{ ...unrelated, destinations: [...unrelated.destinations, { type: "public", uri: "example.com/api" }] }], "links admin", domains[0]!, domains));
  assert.throws(() => validate({ ...application, destinations: [{ type: "private", uri: "example.com/api" }] }));
  assert.throws(() => findExistingApplication([{ id: "ssh", name: "ssh", type: "ssh", domain: "example.com/admin" }], "links admin", domains[0]!, domains));
  assert.throws(() => findExistingApplication([{ id: "rdp", name: "rdp", type: "rdp", destinations: [{ type: "public", uri: "example.com/api" }] }], "links admin", domains[0]!, domains));
  assert.equal(findExistingApplication([{ id: "saas", name: "saas", type: "saas" }, { id: "bookmark", name: "bookmark", type: "bookmark" }], "links admin", domains[0]!, domains), undefined);
});

test("Access session duration may not exceed the duration used by setup", () => {
  for (const sessionDuration of ["8h", "30m", "1h30m", "7h59m59s", "480m", "28800s", "0.5h"]) validate({ ...application, session_duration: sessionDuration });
  for (const sessionDuration of ["24h", "9h", "8h1ns", "8h0m1s", "", "garbage", "8", "8 h", "8h garbage", "-1h", "1d"]) {
    assert.throws(() => validate({ ...application, session_duration: sessionDuration }), Error, sessionDuration);
  }
  const { session_duration: _configured, ...withoutSessionDuration } = application;
  assert.throws(() => validate(withoutSessionDuration), /exceeds/);
  validate({ ...application, policies: [{ ...application.policies[0], session_duration: "1h" }] });
  for (const sessionDuration of ["720h", "8h1s", "garbage"]) {
    assert.throws(() => validate({ ...application, policies: [{ ...application.policies[0], session_duration: sessionDuration }] }), Error, sessionDuration);
  }
});

test("Access session duration boundary is exact to the nanosecond and rejects finer fractions", () => {
  validate({ ...application, session_duration: "8h0.000000000s" });
  validate({ ...application, session_duration: "8h0.9ns" });
  validate({ ...application, session_duration: "7h59m59.999999999s" });
  assert.throws(() => validate({ ...application, session_duration: "8h0.000000001s" }), /exceeds/);
  assert.throws(() => validate({ ...application, session_duration: "8h1ns" }), /exceeds/);
  // forms Go accepts but this deliberately strict parser rejects, so an unreadable value never passes as a short session.
  // Go rounds a fraction through float64, so a fraction beyond nanosecond precision fails closed instead of being truncated.
  for (const sessionDuration of ["0", "+8h", "8.h", "-0", "8h+1m", "8h0.0000000009s", "7h59m59.9999999999s", "0.1234567890h"]) {
    assert.throws(() => validate({ ...application, session_duration: sessionDuration }), /unparsable/, sessionDuration);
  }
});

// mirrors the shape Cloudflare returns for an application this setup created, with fake values. the policy carries no
// session_duration and the application carries no allow_authenticate_via_warp key.
const returnedApplication = {
  id: "11111111-1111-4111-8111-111111111111", uid: "11111111-1111-4111-8111-111111111111", type: "self_hosted", name: "links admin",
  aud: "audience", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", domain: domains[0], self_hosted_domains: domains,
  destinations: domains.map((uri) => ({ type: "public", uri })), app_launcher_visible: true, allowed_idps: ["provider"], tags: [],
  auto_redirect_to_identity: true,
  policies: [{
    created_at: "2026-01-01T00:00:00Z", decision: "allow", exclude: [], id: "22222222-2222-4222-8222-222222222222",
    include: [{ email: { email: "admin@example.com" } }], name: "links admin", require: [], uid: "22222222-2222-4222-8222-222222222222",
    updated_at: "2026-01-01T00:00:00Z", reusable: false, precedence: 1,
  }],
  session_duration: "8h", enable_binding_cookie: false, http_only_cookie_attribute: true, options_preflight_bypass: false,
  eager_redirect_cookie_setting: false,
};
test("the application shape Cloudflare returns validates when WARP authentication is unset or disabled", () => {
  validate(returnedApplication);
  validate(returnedApplication, organisationAllowingWarp());
  validate(returnedApplication, organisationAllowingWarp(null));
  validate(returnedApplication, organisationAllowingWarp(false));
  assert.throws(() => validate(returnedApplication, organisationAllowingWarp(true)), /Cloudflare One Client/);
});
test("null Access durations and WARP settings are treated as unset", () => {
  const withApplicationDuration = (sessionDuration: string | null) => ({ ...returnedApplication, session_duration: sessionDuration });
  const withPolicyDuration = (sessionDuration: string | null) => ({ ...returnedApplication, policies: [{ ...returnedApplication.policies[0], session_duration: sessionDuration }] });
  // an unset application duration is cloudflare's 24h default, which exceeds the limit.
  assert.throws(() => validate(withApplicationDuration(null)), /application session duration exceeds/);
  // an unset policy duration is no override, so the application's own duration decides.
  validate(withPolicyDuration(null));
  assert.throws(() => validate({ ...withPolicyDuration(null), session_duration: "9h" }), /application session duration exceeds/);
  assert.throws(() => validate({ ...withPolicyDuration(null), session_duration: null }), /application session duration exceeds/);
  assert.throws(() => validate(withPolicyDuration("9h")), /policy session duration exceeds/);
  validate({ ...returnedApplication, allow_authenticate_via_warp: null });
  validate({ ...returnedApplication, allow_authenticate_via_warp: null }, organisationAllowingWarp(null));
});
test("a policy session duration overrides the application's when bounding the effective session", () => {
  const { session_duration: _configured, ...withoutApplicationDuration } = application;
  validate({ ...withoutApplicationDuration, policies: [{ ...application.policies[0], session_duration: "8h" }] });
  validate({ ...application, session_duration: "24h", policies: [{ ...application.policies[0], session_duration: "1h" }] });
  assert.throws(() => validate({ ...application, session_duration: "24h" }), /Access application session duration exceeds/);
  assert.throws(() => validate({ ...application, session_duration: "garbage", policies: [{ ...application.policies[0], session_duration: "1h" }] }), /unparsable/);
});
test("Access application may not allow authentication through the Cloudflare One Client", () => {
  assert.throws(() => validate({ ...application, allow_authenticate_via_warp: true }), /Cloudflare One Client/);
  assert.throws(() => validate({ ...application, allow_authenticate_via_warp: true }, organisationAllowingWarp(false)), /Cloudflare One Client/);
  validate({ ...application, allow_authenticate_via_warp: false }, organisationAllowingWarp(true));
  validate({ ...application, allow_authenticate_via_warp: false }, organisationAllowingWarp(false));
  assert.throws(() => validate(application, organisationAllowingWarp(true)), /Cloudflare One Client/);
  assert.throws(() => validate({ ...application, allow_authenticate_via_warp: null }, organisationAllowingWarp(true)), /Cloudflare One Client/);
  validate(application, organisationAllowingWarp(false));
  validate(application, organisationAllowingWarp());
  validate(application, organisationAllowingWarp(null));
});

test("Access application may not carry destination overrides or the preflight bypass", () => {
  const publicDestinations = domains.map((uri) => ({ type: "public", uri }));
  const withOverrides = (overrides: unknown) => ({ ...returnedApplication, destinations: publicDestinations.map((destination, index) => index === 1 ? { ...destination, overrides } : destination) });
  validate(withOverrides(undefined));
  validate(withOverrides(null));
  validate(withOverrides([]));
  assert.throws(() => validate(withOverrides([{ uri: "example.com/api/public", type: "public" }])), /destination override/);
  assert.throws(() => validate({ ...application, destinations: publicDestinations.map((destination) => ({ ...destination, overrides: [{}] })) }), /destination override/);
  validate({ ...returnedApplication, options_preflight_bypass: false });
  validate({ ...returnedApplication, options_preflight_bypass: null });
  assert.throws(() => validate({ ...returnedApplication, options_preflight_bypass: true }), /options_preflight_bypass/);
  assert.throws(() => validate({ ...application, options_preflight_bypass: true }), /options_preflight_bypass/);
});

test("profiling title reserve follows the largest suffix the sample count produces", () => {
  const titleOfLength = (length: number) => "t".repeat(length);
  assert.equal(parseProfileTitle(titleOfLength(117), 100), titleOfLength(117));
  assert.throws(() => parseProfileTitle(titleOfLength(118), 100));
  assert.equal(parseProfileTitle(titleOfLength(117), 11), titleOfLength(117));
  assert.throws(() => parseProfileTitle(titleOfLength(118), 11));
  assert.equal(parseProfileTitle(titleOfLength(118), 10), titleOfLength(118));
  assert.throws(() => parseProfileTitle(titleOfLength(119), 10));
  assert.equal(parseProfileTitle(titleOfLength(118), 2), titleOfLength(118));
});
