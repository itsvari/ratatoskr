# Deploy and operate Ratatoskr

## Prepare your account

1. Add your domain as an active zone in Cloudflare.
2. Create a Zero Trust organisation if you do not already have one.
3. Install the Cloudflare `cf` CLI and Bun.
4. Authenticate `cf` with `cf auth login`.
5. Authenticate Wrangler with `bunx wrangler login`, or provide a Cloudflare API token through your environment.

OAuth credentials remain in the CLIs' own configuration directories. Do not copy them into the repository.

For a scoped API token, grant access to the chosen account and zone. Setup needs account and zone reads, D1 writes, and Access application, policy and identity-provider writes. Publication needs Workers script and route writes, plus the permissions required for Worker custom domains. A token must also read the existing Zero Trust organisation. Consult the [Cloudflare permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) for the current permission names.

Agents use the same commands. Set `CF_EXECUTABLE` if the authenticated CLI is outside PATH. For command discovery, use anonymous action descriptions with `cf cli search`. Do not put account IDs, domains, email addresses or credentials in discovery searches.

## Configure the application

```sh
bun install --frozen-lockfile
bun run verify
bun run setup --domain example.com --admin-subdomain --preview-subdomain
```

The default Worker and database name is `ratatoskr`. Set `--name` for another deployment. Pass `--account-id` if your login can access multiple accounts. By default, the administrator is the authenticated Cloudflare user's email. Set `--email` to an explicit email or a comma-separated allowlist.

With `--admin-subdomain`, administration and its API use `admin.example.com`. The public hostname's `/admin/` redirects there; its `/api` endpoints return 404. Without that flag, administration uses `example.com/admin/`, and Access protects the admin, API and asset paths. With `--preview-subdomain`, `preview.example.com/slug` provides previews. The `slug+` suffix always works.

Setup reuses resources with the same deployment name. It refuses an unrelated Access application on the requested hostname or an existing policy that differs from the requested allowlist. Setup adds a restricted Cloudflare identity provider if needed. It does not change other Access applications or the organisation's existing login providers.

Setup writes `wrangler.deploy.json` and `deployment-state.json`. Both are ignored by Git and contain resource identifiers and deployment settings, not credentials. Keep them for later deployments. To reconstruct them, rerun setup with the same options.

## Publish and check the result

```sh
bun run deploy
bun run verify:deployment
```

Publication uses the generated Worker configuration under `dist/`. It applies outstanding D1 migrations and publishes the public, admin and optional preview custom domains. It disables `workers.dev` and version-preview URLs. No paid service is required by the application.

DNS and TLS provisioning can take time. Verification retries briefly. If your system resolver has cached a DNS miss, verification queries Cloudflare DNS over HTTPS and connects to the returned address with normal hostname and TLS certificate validation. It does not change your system DNS configuration. Rerun verification after DNS propagation if needed.

Then sign in through Access and complete these checks in the admin panel:

1. Create a custom link and a generated link.
2. Check that each shortlink redirects and each preview shows the stored destination.
3. Edit a destination and check that the next lookup uses the new URL.
4. Revoke the link and check that both redirect and preview stop working.
5. Restore it, then delete it.
6. Check that the deleted slug cannot be recreated.
7. Switch appearance modes and check that the preference survives reload.

The automatic deployment check verifies unauthenticated protection. The tests verify signed JWT processing with real cryptography. Neither replaces a browser check of your account's login.

For an optional live public-behaviour check, run `bun run verify:live-links`. This writes a uniquely named temporary fixture directly to the deployment's D1 database, checks redirects and both previews through HTTPS, changes its destination and status, then removes only that fixture. It requires authenticated `cf` database access. It does not test the authenticated management API or replace the browser checks above.

## Change administrators

Update the Access application's email allowlist and `ADMIN_EMAILS` in `wrangler.deploy.json` together. Both controls must authorise the administrator. Keep the Cloudflare identity provider restricted to account members. Redeploy after updating Worker variables.

Future administrators have separate Access subject records in D1. There are no application passwords or passkeys to recover. If you lose account access, use Cloudflare's account recovery process. Never add an Access bypass policy to restore access.

## Back up and restore links

Use **Export** in the admin panel for a JSON copy of current links. For a complete schema, audit and reservation backup, export D1:

```sh
bunx wrangler d1 export ratatoskr --remote --config wrangler.deploy.json --output backup.sql
```

Treat backups as private because destinations can contain sensitive query strings. Do not commit them.

To rehearse restoration, create a separate D1 database and apply the SQL backup there. Point a staging Worker at that database and a separate Access application. Verify the links before changing production's database binding. Do not restore an old backup over the current database without reviewing newer links and slug reservations.

## Update and roll back

Before updating dependencies, export the database. Run `bun run verify`, check local browser behaviour, and deploy. Keep migrations compatible with the previous Worker during rollout. Worker code rollback does not roll back D1 schema or data.

Use `bunx wrangler rollback --config dist/ratatoskr/wrangler.json` to restore a previous compatible Worker version. Keep a record of the version ID printed by each deployment. Test schema reversibility on a separate database before any destructive migration.

## Configure local development

```sh
cp .dev.vars.example .dev.vars
bunx wrangler d1 migrations apply ratatoskr --local --config wrangler.jsonc
bun run dev
```

Vite and Wrangler share the repository's `.wrangler/state` directory. Local mode accepts the development identity only on the configured HTTP loopback origin. It also permits Vite's local development scripts. Production settings omit `LOCAL_DEVELOPMENT`, and HTTPS origins cannot activate that mode even if the flag is accidentally present.

Keep `.dev.vars` out of Git. The build can copy that file into its local output for development, but Wrangler publication uses the deployment configuration's variables. Do not pass `.dev.vars` as a production secrets file.

## Stored preview images

Apply all numbered migrations before publication. Preview bodies are now stored in D1. The admin browser renders a body after creating or editing a link and uploads it through the authenticated, Origin-checked API. Public requests read primary D1 and assemble PNG bytes without Wasm or font loading. Redirects do not wait for image generation.

Existing links need **Regenerate preview image** in the admin panel after the migration. External API clients must upload a body to `POST /api/links/:slug/image` after creating a link or changing its title/destination. Use `shared/preview-image.ts` for the bounded wire format and `shared/preview-compression.ts` for encoding. Failed or interrupted generation leaves the image unavailable with an uncached 503; the admin regeneration action retries it. A stale upload returns 409. Revocation and expiry block access immediately, and deletion removes stored image data while reserving the slug.

The default branding section is a build-time asset. Regenerate it with `bun run generate:preview-header` after changing the template or font. Keep its 72-row boundary above link-specific content. See `docs/preview-performance.md` for limits, staging evidence and remaining uncertainty.
