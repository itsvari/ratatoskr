import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applicationSchema, findExistingApplication, validateApplication } from "../scripts/deployment-access.ts";

const domains = ["example.com/admin", "example.com/api", "example.com/assets"];
const application = {
  id: "id", name: "links admin", type: "self_hosted", domain: domains[0], aud: "audience", allowed_idps: ["provider"],
  self_hosted_domains: domains, policies: [{ decision: "allow", include: [{ email: { email: "admin@example.com" } }], exclude: [], require: [] }],
};
function validate(value: unknown): void {
  validateApplication(applicationSchema.parse(value), "links admin", domains[0]!, domains, "provider", ["admin@example.com"]);
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
