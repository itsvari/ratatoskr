import { authenticate } from "./auth";
import {
    deleteLink,
    generateSlug,
    getLink,
    isValidSlug,
    listLinks,
    putLink,
} from "./links";
import type { Env, LinkRecord } from "./types";

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: HeadersInit = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
};

// Slugs that would shadow top-level API routes if used as shortlinks.
const RESERVED_SLUGS = new Set(["api"]);

// Retrying a handful of times keeps the collision window negligible even at
// high KV fill rates, without risking an unbounded loop.
const MAX_SLUG_GENERATION_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function notFound(): Response {
    return jsonResponse({ error: "Not found" }, 404);
}

function methodNotAllowed(): Response {
    return jsonResponse({ error: "Method not allowed" }, 405);
}

function badRequest(message: string): Response {
    return jsonResponse({ error: message }, 400);
}

function conflict(message: string): Response {
    return jsonResponse({ error: message }, 409);
}

function addSecurityHeaders(response: Response): Response {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        headers.set(name, value);
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleHealth(): Response {
    return jsonResponse({ status: "ok" });
}

async function handleListLinks(env: Env): Promise<Response> {
    const links = await listLinks(env.LINKS);
    return jsonResponse(links);
}

async function handleCreateLink(request: Request, env: Env): Promise<Response> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return badRequest("Request body must be valid JSON");
    }

    if (typeof body !== "object" || body === null) {
        return badRequest("Request body must be a JSON object");
    }

    const { url, slug: requestedSlug } = body as Record<string, unknown>;

    if (typeof url !== "string" || url.trim() === "") {
        return badRequest("Field 'url' is required and must be a non-empty string");
    }

    let destination: URL;
    try {
        destination = new URL(url);
    } catch {
        return badRequest("Field 'url' must be a valid absolute URL");
    }

    if (destination.protocol !== "http:" && destination.protocol !== "https:") {
        return badRequest("Field 'url' must use the http or https scheme");
    }

    const slugOrFailure = await resolveSlug(requestedSlug, env);
    if (slugOrFailure instanceof Response) {
        return slugOrFailure;
    }

    const collision = await getLink(env.LINKS, slugOrFailure);
    if (collision !== null) {
        return conflict(`Slug '${slugOrFailure}' is already in use`);
    }

    const record: LinkRecord = {
        slug: slugOrFailure,
        url: destination.toString(),
        createdAt: new Date().toISOString(),
    };

    await putLink(env.LINKS, record);
    return jsonResponse(record, 201);
}

/**
 * Resolves the slug to use for a new link.
 *
 * Returns the slug string on success, or a Response on validation failure.
 * Extracted to keep handleCreateLink within a comfortable indentation depth.
 */
async function resolveSlug(requestedSlug: unknown, env: Env): Promise<string | Response> {
    if (requestedSlug !== undefined) {
        return validateCustomSlug(requestedSlug);
    }
    return generateUniqueSlug(env);
}

function validateCustomSlug(requestedSlug: unknown): string | Response {
    if (typeof requestedSlug !== "string" || !isValidSlug(requestedSlug)) {
        return badRequest(
            "Field 'slug' must be a non-empty string containing only alphanumeric characters and hyphens",
        );
    }

    if (RESERVED_SLUGS.has(requestedSlug.toLowerCase())) {
        return badRequest(`Slug '${requestedSlug}' is reserved`);
    }

    return requestedSlug;
}

async function generateUniqueSlug(env: Env): Promise<string | Response> {
    for (let attempt = 0; attempt < MAX_SLUG_GENERATION_ATTEMPTS; attempt++) {
        const candidate = generateSlug();
        const existing = await getLink(env.LINKS, candidate);
        if (existing === null) {
            return candidate;
        }
    }

    return jsonResponse(
        { error: "Could not generate a unique slug — please try again" },
        503,
    );
}

async function handleDeleteLink(slug: string, env: Env): Promise<Response> {
    const existing = await getLink(env.LINKS, slug);
    if (existing === null) {
        return notFound();
    }

    await deleteLink(env.LINKS, slug);
    return new Response(null, { status: 204 });
}

async function handleRedirect(slug: string, env: Env): Promise<Response> {
    const record = await getLink(env.LINKS, slug);
    if (record === null) {
        return notFound();
    }

    return Response.redirect(record.url, 301);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function route(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const { method } = request;

    if (pathname === "/api/health") {
        return method === "GET" ? handleHealth() : methodNotAllowed();
    }

    if (method === "GET" && !pathname.startsWith("/api/")) {
        const slug = pathname.slice(1);
        return slug !== "" && isValidSlug(slug)
            ? handleRedirect(slug, env)
            : notFound();
    }

    const authFailure = authenticate(request, env);
    if (authFailure !== null) {
        return authFailure;
    }

    if (pathname === "/api/links") {
        if (method === "POST") return handleCreateLink(request, env);
        if (method === "GET") return handleListLinks(env);
    }

    const slugCapture = pathname.match(/^\/api\/links\/([^/]+)$/);
    if (slugCapture !== null && method === "DELETE") {
        return handleDeleteLink(slugCapture[1] as string, env);
    }

    return notFound();
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const response = await route(request, env);
        return addSecurityHeaders(response);
    },
} satisfies ExportedHandler<Env>;
