import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { Configuration } from "./configuration";

export interface Administrator {
  readonly subject: string;
  readonly email: string;
}

const claimsSchema = z.object({ sub: z.string().min(1), email: z.email(), exp: z.number(), iat: z.number() });
const signingKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const UNSAFE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export async function authenticate(request: Request, configuration: Configuration): Promise<Administrator | null> {
  if (configuration.localDevelopment && new URL(request.url).origin === configuration.adminOrigin) {
    return { subject: "local-development", email: "developer@localhost" };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return null;
  }
  let keys = signingKeys.get(configuration.accessIssuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${configuration.accessIssuer}/cdn-cgi/access/certs`));
    signingKeys.set(configuration.accessIssuer, keys);
  }
  try {
    const result = await jwtVerify(token, keys, {
      issuer: configuration.accessIssuer, audience: configuration.accessAudience,
      algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "email"],
    });
    const claims = claimsSchema.safeParse(result.payload);
    if (!claims.success || !configuration.administratorEmails.includes(claims.data.email.toLowerCase())) {
      return null;
    }
    return { subject: claims.data.sub, email: claims.data.email.toLowerCase() };
  } catch {
    return null;
  }
}

export function acceptsMutation(request: Request, configuration: Configuration): boolean {
  if (!UNSAFE_METHODS.has(request.method)) {
    return true;
  }
  return request.headers.get("Origin") === configuration.adminOrigin
    && !["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site") ?? "");
}
