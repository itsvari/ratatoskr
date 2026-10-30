import { env as environment } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { createLinkSchema, linkExportFilename, linkStatusSchema, updateSiteSettingsSchema, updateLinkSchema, type SiteSettings } from "../shared/contracts";
import { acceptsMutation, authenticate, type Administrator } from "./auth";
import { loadConfiguration, type Bindings, type Configuration } from "./configuration";
import { ApplicationError } from "./errors";
import { createLink, deleteLink, exportLinks, getLink, listLinks, updateLink } from "./links";
import { brandAdminPage, renderHome, renderPreview, renderUnavailable } from "./preview";
import { previewUploadSchema, MAXIMUM_PREVIEW_UPLOAD_BYTES } from "../shared/preview-image";
import { renderPreviewImage, storePreviewImage } from "./preview-image";
import { destinationHasPreviewImage, isPreviewCrawler } from "./social-preview";
import { parseCustomSlug } from "./slugs";
import { getSiteSettings, updateSiteSettings } from "./settings";

const MAXIMUM_REQUEST_BYTES = 8192;
const HTTP_METHODS = new Set(["GET", "HEAD"]);
const PUBLIC_FONT_PATHS = new Set(["/_fonts/inter.woff2", "/_fonts/jetbrains-mono.woff2"]);
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

interface RequestVariables {
  readonly configuration: Configuration;
  readonly administrator: Administrator;
  readonly siteSettings?: Promise<SiteSettings>;
}

type ApplicationEnvironment = { Bindings: Bindings; Variables: RequestVariables };
const application = new Hono<ApplicationEnvironment>();

function readSettings(context: Context<ApplicationEnvironment>): Promise<SiteSettings> {
  const existing = context.get("siteSettings");
  if (existing) return existing;
  const settings = getSiteSettings(context.env.DB);
  context.set("siteSettings", settings);
  return settings;
}

async function unavailable(context: Context<ApplicationEnvironment>, status: 404 | 410 | 429): Promise<Response> {
  return renderUnavailable(status, (await readSettings(context)).displayName);
}

async function parseBody<Schema extends z.ZodType>(request: Request, schema: Schema, maximumBytes = MAXIMUM_REQUEST_BYTES): Promise<z.output<Schema>> {
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new ApplicationError("Send the request as application/json.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new ApplicationError("Provide a JSON request body.", 400);
  }
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    receivedBytes += result.value.byteLength;
    if (receivedBytes > maximumBytes) {
      await reader.cancel();
      throw new ApplicationError("Request body is too large.", 413);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(receivedBytes);
  let offsetBytes = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offsetBytes);
    offsetBytes += chunk.byteLength;
  }
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const parsed = schema.safeParse(decoded);
    if (!parsed.success) {
      throw new ApplicationError(parsed.error.issues[0]?.message ?? "Invalid request body.", 400);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("Request body must be valid JSON.", 400);
  }
}

function isAdministrationPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/")
    || pathname === "/api" || pathname.startsWith("/api/") || pathname.startsWith("/assets/");
}

function isLocalAssetPath(pathname: string): boolean {
  return pathname.startsWith("/@") || pathname.startsWith("/node_modules/")
    || /\.(?:tsx?|m?js|css)$/.test(pathname);
}

application.use("*", async (context, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) context.header(name, value);
  context.header("Cache-Control", "no-store");
  if (context.get("configuration")?.localDevelopment) {
    context.header("Content-Security-Policy", SECURITY_HEADERS["Content-Security-Policy"]
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*"));
  }
});

application.use("*", async (context, next) => {
  const configuration = loadConfiguration(context.env);
  context.set("configuration", configuration);
  const url = new URL(context.req.url);
  if (![configuration.shortOrigin, configuration.adminOrigin, configuration.previewOrigin].includes(url.origin)) {
    return renderUnavailable(404);
  }
  const separateAdmin = configuration.adminOrigin !== configuration.shortOrigin;
  if (PUBLIC_FONT_PATHS.has(url.pathname) && HTTP_METHODS.has(context.req.method)) {
    return context.env.ASSETS.fetch(context.req.raw);
  }
  if (url.origin === configuration.shortOrigin && separateAdmin && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))) {
    return context.redirect(configuration.adminOrigin, 302);
  }
  const administration = url.origin === configuration.adminOrigin
    && (separateAdmin || isAdministrationPath(url.pathname)
      || (configuration.localDevelopment && isLocalAssetPath(url.pathname)));
  if (administration) {
    const administrator = await authenticate(context.req.raw, configuration);
    if (!administrator) return context.json({ error: "Sign in through Cloudflare Access to continue." }, 401);
    if (!acceptsMutation(context.req.raw, configuration)) return context.json({ error: "This request must come from the admin panel." }, 403);
    if (!configuration.localDevelopment && url.pathname.startsWith("/api/")) {
      const allowance = await context.env.ADMIN_LIMITER.limit({ key: administrator.subject });
      if (!allowance.success) {
        context.header("Retry-After", "60");
        return context.json({ error: "Too many requests. Please try again in a minute." }, 429);
      }
    }
    context.set("administrator", administrator);
    await next();
    return;
  }
  if (isAdministrationPath(url.pathname)) return renderUnavailable(404);
  if (!HTTP_METHODS.has(context.req.method)) return context.json({ error: "Method not allowed." }, 405, { Allow: "GET, HEAD" });
  if (url.pathname !== "/" && url.pathname !== "/_health") {
    const allowance = await context.env.PUBLIC_LIMITER.limit({ key: context.req.header("CF-Connecting-IP") ?? "anonymous" });
    if (!allowance.success) {
      context.header("Retry-After", "60");
      return renderUnavailable(429, "Shortlinks");
    }
  }
  await next();
});

application.get("/api/session", async (context) => {
  const configuration = context.get("configuration");
  return context.json({ email: context.get("administrator").email, shortOrigin: configuration.shortOrigin,
    adminOrigin: configuration.adminOrigin, previewOrigin: configuration.previewOrigin,
    displayName: (await readSettings(context)).displayName });
});

application.get("/api/settings", async (context) => context.json(await readSettings(context)));

application.patch("/api/settings", async (context) => {
  const settings = await parseBody(context.req.raw, updateSiteSettingsSchema, MAXIMUM_PREVIEW_UPLOAD_BYTES);
  return context.json(await updateSiteSettings(context.env.DB, context.get("administrator"), settings));
});

application.get("/api/links", async (context) => {
  const status = context.req.query("status");
  const parsedStatus = status === undefined ? undefined : linkStatusSchema.safeParse(status);
  if (parsedStatus && !parsedStatus.success) throw new ApplicationError("Invalid status filter.", 400);
  const cursor = context.req.query("cursor");
  return context.json(await listLinks(context.env.DB, {
    search: context.req.query("search") ?? "",
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    ...(cursor ? { cursor } : {}),
  }));
});

application.post("/api/links", async (context) => {
  const draft = await parseBody(context.req.raw, createLinkSchema);
  return context.json(await createLink({ database: context.env.DB, configuration: context.get("configuration"),
    administrator: context.get("administrator"), draft }), 201);
});

application.patch("/api/links/:slug", async (context) => {
  const slug = parseCustomSlug(context.req.param("slug"));
  if (!slug) throw new ApplicationError("Invalid shortlink.", 400);
  const patch = await parseBody(context.req.raw, updateLinkSchema);
  return context.json(await updateLink({ database: context.env.DB, configuration: context.get("configuration"),
    administrator: context.get("administrator"), slug, patch }));
});

application.post("/api/links/:slug/image", async (context) => {
  const slug = parseCustomSlug(context.req.param("slug"));
  if (!slug) throw new ApplicationError("Invalid shortlink.", 400);
  const upload = await parseBody(context.req.raw, previewUploadSchema, MAXIMUM_PREVIEW_UPLOAD_BYTES);
  if (upload.origin !== context.get("configuration").shortOrigin) throw new ApplicationError("The image origin changed. Reload the admin panel.", 409);
  await storePreviewImage(context.env.DB, slug, upload);
  return context.body(null, 204);
});

application.delete("/api/links/:slug", async (context) => {
  const slug = parseCustomSlug(context.req.param("slug"));
  if (!slug) throw new ApplicationError("Invalid shortlink.", 400);
  await deleteLink(context.env.DB, slug, context.get("administrator"));
  return context.body(null, 204);
});

application.get("/api/export", async (context) => {
  const { displayName } = await readSettings(context);
  return context.json(await exportLinks(context.env.DB), 200, {
    "Content-Disposition": `attachment; filename="${linkExportFilename(displayName)}"`,
  });
});

application.get("*", async (context) => {
  const configuration = context.get("configuration");
  const url = new URL(context.req.url);
  const separateAdmin = configuration.adminOrigin !== configuration.shortOrigin;
  if (configuration.localDevelopment && url.origin === configuration.adminOrigin && isLocalAssetPath(url.pathname)) {
    return context.env.ASSETS.fetch(context.req.raw);
  }
  if (url.origin === configuration.adminOrigin && (separateAdmin || isAdministrationPath(url.pathname))) {
    if (url.pathname.startsWith("/api")) return context.json({ error: "Not found." }, 404);
    if (url.pathname.startsWith("/assets/")) return context.env.ASSETS.fetch(context.req.raw);
    if (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/admin/") {
      const assetUrl = new URL("/index.html", configuration.adminOrigin);
      const response = await context.env.ASSETS.fetch(new Request(assetUrl, context.req.raw));
      return brandAdminPage(response, (await readSettings(context)).displayName);
    }
    return unavailable(context, 404);
  }
  if (url.pathname === "/_health") return context.json({ status: "ok" });
  if (url.pathname === "/") {
    if (url.origin !== configuration.shortOrigin) return unavailable(context, 404);
    return renderHome(separateAdmin ? configuration.adminOrigin : `${configuration.adminOrigin}/admin/`, (await readSettings(context)).displayName);
  }
  const imageSlug = /^\/_preview\/([a-z0-9-]+)\.png$/.exec(url.pathname)?.[1];
  const requestedSlug = imageSlug ?? url.pathname.slice(1);
  const preview = url.origin === configuration.previewOrigin || requestedSlug.endsWith("+");
  const slug = parseCustomSlug(requestedSlug.endsWith("+") ? requestedSlug.slice(0, -1) : requestedSlug);
  if (!slug) return unavailable(context, 404);
  if (imageSlug) {
    const response = await renderPreviewImage(context.env.DB, slug, configuration.shortOrigin, { head: context.req.method === "HEAD" });
    return response.status === 404 || response.status === 410 ? unavailable(context, response.status) : response;
  }
  const link = await getLink(context.env.DB, slug);
  if (!link) return unavailable(context, 404);
  if (link.status !== "active" || (link.expiresAt !== null && Date.parse(link.expiresAt) <= Date.now())) return unavailable(context, 410);
  if (preview) return renderPreview(link, configuration.shortOrigin, (await readSettings(context)).displayName);
  context.header("Vary", "User-Agent");
  if (isPreviewCrawler(context.req.header("User-Agent") ?? "")
    && !await destinationHasPreviewImage(link.destination, [configuration.shortOrigin, configuration.adminOrigin, configuration.previewOrigin])) {
    const response = renderPreview(link, configuration.shortOrigin, (await readSettings(context)).displayName);
    response.headers.set("Vary", "User-Agent");
    return response;
  }
  return context.redirect(link.destination, 302);
});

application.notFound((context) => context.json({ error: "Not found." }, 404));
application.onError(async (error, context) => {
  if (error instanceof ApplicationError) return context.json({ error: error.message }, error.status);
  if (context.get("configuration")?.localDevelopment) console.error(error);
  console.error(JSON.stringify({ event: "request_failed", error: error instanceof z.ZodError ? "invalid_configuration_or_data" : "internal_error" }));
  if (context.req.path.startsWith("/api/")) return context.json({ error: "Temporarily unavailable. Please try again." }, 503);
  const settings = await readSettings(context).catch(() => null);
  return renderUnavailable(503, settings?.displayName);
});

// compile the fixed routes within the startup budget rather than the first request's CPU budget.
application.router.match("GET", "/_health");
// validate the deployment at startup; requests still validate their current bindings after updates.
loadConfiguration(environment);

export default { fetch: application.fetch } satisfies ExportedHandler<Bindings>;
