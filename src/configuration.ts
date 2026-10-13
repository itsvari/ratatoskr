import { z } from "zod";

export interface Bindings {
  readonly DB: D1Database;
  readonly ASSETS: Fetcher;
  readonly ADMIN_LIMITER: RateLimit;
  readonly PUBLIC_LIMITER: RateLimit;
  readonly SHORT_ORIGIN: string;
  readonly ADMIN_ORIGIN: string;
  readonly PREVIEW_ORIGIN: string;
  readonly ACCESS_ISSUER: string;
  readonly ACCESS_AUDIENCE: string;
  readonly ADMIN_EMAILS: string;
  readonly LOCAL_DEVELOPMENT?: string;
}

export interface Configuration {
  readonly shortOrigin: string;
  readonly adminOrigin: string;
  readonly previewOrigin: string | null;
  readonly accessIssuer: string;
  readonly accessAudience: string;
  readonly administratorEmails: readonly string[];
  readonly localDevelopment: boolean;
}

const originSchema = z.url().transform((value, context) => {
  const url = new URL(value);
  const localOrigin = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!localOrigin && url.protocol !== "https:") || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "Configure an HTTPS origin without a path." });
    return z.NEVER;
  }
  return url.origin;
});

export function loadConfiguration(environment: Bindings): Configuration {
  const shortOrigin = originSchema.parse(environment.SHORT_ORIGIN);
  const adminOrigin = originSchema.parse(environment.ADMIN_ORIGIN || shortOrigin);
  const previewOrigin = environment.PREVIEW_ORIGIN ? originSchema.parse(environment.PREVIEW_ORIGIN) : null;
  const accessIssuer = originSchema.parse(environment.ACCESS_ISSUER);
  const administratorEmails = environment.ADMIN_EMAILS.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  const localDevelopment = environment.LOCAL_DEVELOPMENT === "true"
    && new URL(adminOrigin).protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(adminOrigin).hostname);
  if ((!localDevelopment && (!environment.ACCESS_AUDIENCE || administratorEmails.length === 0))
    || (previewOrigin !== null && [shortOrigin, adminOrigin].includes(previewOrigin))) {
    throw new Error("Incomplete or conflicting application configuration.");
  }
  if (!localDevelopment && (!accessIssuer.endsWith(".cloudflareaccess.com") || !accessIssuer.startsWith("https://"))) {
    throw new Error("Configure a Cloudflare Access team origin.");
  }
  return {
    shortOrigin, adminOrigin, previewOrigin, accessIssuer,
    accessAudience: environment.ACCESS_AUDIENCE, administratorEmails, localDevelopment,
  };
}
