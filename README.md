# Ratatoskr

A private link shortener that runs on Cloudflare Workers, D1 and Workers Static Assets. Cloudflare Access handles administrator sign-in using your Cloudflare account.

## Run locally

Use Bun 1.4.4 or later and patched Node.js 22.23.4, 24.22.1 or 26.12.1 (or a newer supported release). `.bun-version` and `.node-version` pin the current development versions. Install, development, build and verification commands check these security minimums.

Bun 1.4.4 and the [October 2026 Node.js releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) include the Brotli RCE fix (CVE-2026-111497) and updated certificate trust. Upgrade the runtimes themselves before installing packages; changing the lockfile does not patch an installed runtime. See the [Bun release notes](https://bun.sh/blog/bun-v1.4.4).

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bunx wrangler d1 migrations apply ratatoskr --local --config wrangler.jsonc
bun run dev
```

Open `http://localhost:5173/admin/`. Local mode uses a development identity on the loopback origin. Production origins always require Access.

## Deploy to your account

Use an active Cloudflare zone and an existing Zero Trust organisation. Install the [Cloudflare CLI](https://github.com/cloudflare/cf) and sign in with `cf auth login`. Sign in with `bunx wrangler login` for Worker publication, or provide a scoped `CLOUDFLARE_API_TOKEN` that supports both CLIs.

```sh
bun run verify
bun run setup --domain example.com --admin-subdomain --preview-subdomain
bun run deploy
```

Setup creates or reuses D1, a Cloudflare identity provider and a private Access application. It writes ignored deployment configuration files. Deployment applies migrations, builds the application, publishes custom domains and checks public routing and Access protection.

If `cf` is outside your PATH, set `CF_EXECUTABLE` to its absolute path. For multiple accounts, pass `--account-id`. To use the main hostname's `/admin/` path, omit `--admin-subdomain`.

Read [DEPLOY.md](DEPLOY.md) for account permissions, configuration, recovery, backups and deployment verification.

## Use links

- Create a custom slug or leave the field empty for a pronounceable generated slug.
- Generated slugs start at six letters. Allocation increases and remembers their length after bounded collision retries, up to 48 letters.
- Preview `example.com/slug+`, or `preview.example.com/slug` when enabled.
- Edit destinations and expiry, revoke or restore a link, or delete it.
- Deleted slugs remain reserved. Deletion erases their destination, title and expiry.
- Export current links as JSON from the admin panel.

The interface defaults to pure-black dark mode, with saved Light and System options. It uses shadcn/ui, Inter and JetBrains Mono, all served from the same deployment.

## Verify changes

```sh
bun run verify
bun audit
bun run verify:deployment
```

The tests run in the Workers runtime with real local D1. They cover concurrent claims, transaction rollback, deletion races, revocation, expiry, previews, Access signatures, origin checks and slug screening. Production sign-in still needs a browser check.

The lockfile refreshes direct and transitive packages. Security overrides keep Cloudflare tooling's Undici on the patched 7.x line and Zod on 4.6.7 or later until their upstream pins catch up. Recheck `bun audit` when updating dependencies.

## Operating limits

The application targets the Workers Free plan. Dynamic requests count against the account's daily Worker allowance. Link resolution uses one indexed primary D1 read and no click-counter writes. Redirects use `302` and `no-store` so edits and revocations take effect for new lookups. Already delivered redirects cannot be recalled.

Private creation, Access and application rate limits reduce abuse. Worker rate limits are location-local and permissive. Distributed bot traffic can still exhaust free allowances. Configure zone-level security rules if you need to reject traffic before Worker invocation.

Generated-slug screening checks substrings and coarse phonetic variants across syllable boundaries. The blocklist covers English and selected common romanisations. It deliberately rejects some benign candidates and cannot guarantee neutrality in every language. Custom slugs are administrator-chosen.

Destination previews display the stored URL without fetching external content. They do not verify a destination's safety or any later redirects.

## Source map

- `src/index.ts`: host routing, HTTP validation and security headers.
- `src/auth.ts`: Access JWT and mutation-origin checks.
- `src/links.ts`: D1 operations and atomic audit records.
- `src/slugs.ts`: generation and screening.
- `admin/`: React, shadcn components and appearance settings.
- `migrations/`: schema changes.
- `scripts/`: provisioning, publication and verification.

The existing [AGPL licence](LICENSE) applies. The dependency packages retain their own licences.
