import type { Env } from "./types";

const BEARER_PREFIX = "Bearer ";

// Constant-time comparison prevents an attacker from learning how many
// characters of their guess were correct by measuring response latency.
function stringsMatch(expected: string, provided: string): boolean {
    const encoder = new TextEncoder();
    const expectedBytes = encoder.encode(expected);
    const providedBytes = encoder.encode(provided);

    if (expectedBytes.length !== providedBytes.length) {
        return false;
    }

    let differingBits = 0;
    for (let index = 0; index < expectedBytes.length; index++) {
        differingBits |= (expectedBytes[index] as number) ^ (providedBytes[index] as number);
    }

    return differingBits === 0;
}

/**
 * Validates the `Authorization: Bearer <token>` header against the configured API key.
 *
 * @returns A `401 Unauthorized` Response if authentication fails, or `null` if it passes.
 */
export function authenticate(request: Request, env: Env): Response | null {
    const authHeader = request.headers.get("Authorization") ?? "";

    if (!authHeader.startsWith(BEARER_PREFIX)) {
        return unauthorised();
    }

    const providedKey = authHeader.slice(BEARER_PREFIX.length);

    if (!stringsMatch(env.API_KEY, providedKey)) {
        return unauthorised();
    }

    return null;
}

function unauthorised(): Response {
    return new Response(JSON.stringify({ error: "Unauthorised" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
    });
}
