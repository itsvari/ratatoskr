# Working on Ratatoskr

Use British English, strict TypeScript and 2-space indentation. Use descriptive names, immutable domain data and `unknown` at external boundaries. Prefer schema-derived types. Comments explain decisions, not mechanics. Use `python`, not `python3`, for Python commands.

## Preserve these behaviours

- Cloudflare hosts all runtime components. Do not add external authentication or storage services.
- Cloudflare Access protects every management path. The Worker verifies signature, issuer, audience, expiry and the email allowlist.
- Management requests use the configured admin origin and exact Origin checks. A separate admin hostname keeps public-host API routes inaccessible.
- Production never enables local authentication. `LOCAL_DEVELOPMENT` applies only to the configured HTTP loopback origin.
- D1 primary reads determine redirects and previews. Do not add KV, replica reads or redirect caches without changing the revocation contract.
- Slug claims and audit writes are atomic. Deleted slugs remain reserved and contain no destination.
- Generation is screened across complete strings and grows beyond six characters after bounded collision retries. Keep the resource bounds and screening caveat.
- Previews do not fetch destinations, metadata or favicons.
- No per-click database writes or raw destination URLs in production logs.
- Fonts are self-hosted. The admin uses shadcn/ui, Inter, JetBrains Mono, purple accents and pure-black dark mode by default.

## Verify your work

Run `bun install --frozen-lockfile` and `bun run verify`. The test suite uses real D1 in the Workers runtime. Preserve `fsModuleCache: false` in the Vitest configuration.

Use the local application to verify UI changes. Apply local migrations with the explicit `wrangler.jsonc` configuration so a previous build's redirect file cannot select another deployment database. Check desktop and mobile layouts, the changed interaction, error states and appearance persistence.

For an authorised deployment, use the repeatable scripts described in `DEPLOY.md`. Do not hand-copy resource IDs into tracked configuration or print credentials. Do not replace unrelated Access applications, DNS records or databases. Use anonymous `cf cli search` descriptions when discovering commands.

After publication, run `bun run verify:deployment` and check the real authenticated flow. State which checks you completed and which required a human login. Do not claim a mock or a build proves the full live behaviour.

## Ownership

`shared/contracts.ts` defines API data shapes. `src/links.ts` owns SQL and link invariants. `src/auth.ts` owns Access validation. `src/index.ts` owns host and HTTP routing. `admin/` owns UI behaviour. `scripts/` owns setup, deployment and repeatable verification.

Generated deployment files, credentials, local state and build output remain ignored. Add schema changes as numbered SQL files in `migrations/`.
