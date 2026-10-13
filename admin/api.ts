import { z } from "zod";
import {
  apiErrorSchema,
  linkPageSchema,
  linkSchema,
  sessionSchema,
  type CreateLink,
  type Link,
  type LinkPage,
  type LinkStatus,
  type Session,
  type UpdateLink,
} from "../shared/contracts";

export class SessionExpiredError extends Error {
  override readonly name = "SessionExpiredError";
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;

  constructor({ message, status }: { readonly message: string; readonly status: number }) {
    super(message);
    this.status = status;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

type RequestOptions = {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
};

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "same-origin",
    cache: "no-store",
    // an expired sign-in answers with a redirect to the login page, which fetch cannot follow cross-origin
    redirect: "manual",
    headers:
      options.body === undefined
        ? { Accept: "application/json" }
        : { Accept: "application/json", "Content-Type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError({
      message: "The server could not be reached. Check your connection and try again.",
      status: 0,
    });
  }

  if (response.type === "opaqueredirect" || response.status === 401) {
    throw new SessionExpiredError("Your session has ended.");
  }

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const parsed = apiErrorSchema.safeParse(payload);
    throw new ApiError({
      message: parsed.success ? parsed.data.error : `The request failed with status ${response.status}.`,
      status: response.status,
    });
  }

  return response;
}

async function readJson<Schema extends z.ZodType>(response: Response, schema: Schema): Promise<z.infer<Schema>> {
  const payload: unknown = await response.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError({ message: "The server sent a response this page does not understand.", status: response.status });
  }
  return parsed.data;
}

function linkPath(slug: string): string {
  return `/api/links/${encodeURIComponent(slug)}`;
}

export async function fetchSession(signal?: AbortSignal): Promise<Session> {
  const response = await request("/api/session", signal === undefined ? {} : { signal });
  return readJson(response, sessionSchema);
}

export async function fetchLinks({
  search,
  status,
  cursor,
  signal,
}: {
  readonly search: string;
  readonly status: LinkStatus | null;
  readonly cursor: string | null;
  readonly signal: AbortSignal;
}): Promise<LinkPage> {
  const parameters = new URLSearchParams();
  if (search !== "") parameters.set("search", search);
  if (status !== null) parameters.set("status", status);
  if (cursor !== null) parameters.set("cursor", cursor);
  const query = parameters.toString();
  const response = await request(query === "" ? "/api/links" : `/api/links?${query}`, { signal });
  return readJson(response, linkPageSchema);
}

export async function createLink(body: CreateLink): Promise<Link> {
  const response = await request("/api/links", { method: "POST", body });
  return readJson(response, linkSchema);
}

export async function updateLink({ slug, changes }: { readonly slug: string; readonly changes: UpdateLink }): Promise<Link> {
  const response = await request(linkPath(slug), { method: "PATCH", body: changes });
  return readJson(response, linkSchema);
}

export async function deleteLink(slug: string): Promise<void> {
  await request(linkPath(slug), { method: "DELETE" });
}

export async function exportLinks(): Promise<readonly Link[]> {
  const response = await request("/api/export");
  return readJson(response, z.array(linkSchema));
}
