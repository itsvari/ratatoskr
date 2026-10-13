import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { acceptsMutation, authenticate } from "../src/auth";
import type { Configuration } from "../src/configuration";

const OWNER_EMAIL = "owner@example.com";
const ISSUER = "https://authentication-test.cloudflareaccess.com";
const ADMIN_ORIGIN = "https://admin.example.com";
const SIGNING_KEY_IDENTIFIER = "fixture-signing-key";
const configuration: Configuration = {
  shortOrigin: "https://example.com", adminOrigin: ADMIN_ORIGIN, previewOrigin: null,
  accessIssuer: ISSUER, accessAudience: "fixture-audience", administratorEmails: [OWNER_EMAIL], localDevelopment: false,
};

let privateKey: CryptoKey;

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const publicKey = await exportJWK(keys.publicKey);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...publicKey, kid: SIGNING_KEY_IDENTIFIER }] }), {
    headers: { "Content-Type": "application/json" },
  })));
});

async function assertion(input: { email?: string; issuer?: string; audience?: string; expiration?: string } = {}) {
  return new SignJWT({ email: input.email ?? OWNER_EMAIL })
    .setProtectedHeader({ alg: "RS256", kid: SIGNING_KEY_IDENTIFIER })
    .setSubject("fixture-owner").setIssuedAt().setIssuer(input.issuer ?? ISSUER)
    .setAudience(input.audience ?? configuration.accessAudience)
    .setExpirationTime(input.expiration ?? "1h").sign(privateKey);
}

function request(token: string) {
  return new Request(`${ADMIN_ORIGIN}/api/session`, { headers: { "Cf-Access-Jwt-Assertion": token } });
}

describe("Cloudflare Access boundary", () => {
  it("verifies real signatures and the administrator allowlist", async () => {
    expect(await authenticate(request(await assertion()), configuration)).toEqual({ subject: "fixture-owner", email: OWNER_EMAIL });
    expect(await authenticate(request(await assertion({ email: "stranger@example.com" })), configuration)).toBeNull();
  });

  it("rejects missing, forged, expired, wrong-issuer and wrong-audience assertions", async () => {
    expect(await authenticate(new Request(ADMIN_ORIGIN), configuration)).toBeNull();
    expect(await authenticate(request("not-a-jwt"), configuration)).toBeNull();
    expect(await authenticate(request(await assertion({ issuer: "https://attacker.example" })), configuration)).toBeNull();
    expect(await authenticate(request(await assertion({ audience: "another-application" })), configuration)).toBeNull();
    expect(await authenticate(request(await assertion({ expiration: "-1h" })), configuration)).toBeNull();
    const valid = await assertion();
    const tampered = `${valid.slice(0, -12)}aaaaaaaaaaaa`;
    expect(await authenticate(request(tampered), configuration)).toBeNull();
  });

  it("requires exact Origin and rejects sibling-domain mutation requests", () => {
    expect(acceptsMutation(new Request(`${ADMIN_ORIGIN}/api/links`, { method: "POST", headers: { Origin: ADMIN_ORIGIN } }), configuration)).toBe(true);
    expect(acceptsMutation(new Request(`${ADMIN_ORIGIN}/api/links`, { method: "POST", headers: { Origin: "https://example.com", "Sec-Fetch-Site": "same-site" } }), configuration)).toBe(false);
    expect(acceptsMutation(new Request(`${ADMIN_ORIGIN}/api/links`, { method: "DELETE" }), configuration)).toBe(false);
  });
});
