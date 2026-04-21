export interface Env {
    LINKS: KVNamespace;
    /** API key for authenticating management endpoints. Set via `wrangler secret put API_KEY`. */
    API_KEY: string;
}

export interface LinkRecord {
    slug: string;
    url: string;
    createdAt: string;
}
