# Security audit record, November 2026

Two independent audits of the codebase were run on 18 November 2026 against commit `6af2bb3`. Both used source review and local Workers/D1 probes only. Neither contacted Cloudflare or the deployed `v4ri.link`, `admin.v4ri.link` or `preview.v4ri.link` hostnames. This record lists every finding, the decision taken, the follow-ups from independent review, and the permanent regressions.

Finding identifiers keep the audits' own labels: `F1`–`F9` from the first audit and `SEC-1`–`SEC-6` from the second.

## Findings and decisions

| Finding | Severity | Decision | Resolution |
| --- | --- | --- | --- |
| F1, SEC-1: percent-encoded management paths | Critical | Fixed | Admission classified the raw `url.pathname` (`/%61pi/links`), while Hono routed the decoded `context.req.path` (`/api/links`). Unauthenticated GETs on the public and preview hostnames, and on same-origin deployments, returned every link, the export and the site settings, and `/%61pi/session` returned 503. The admission middleware now answers 404 whenever the decoded path differs from the raw path, before any handler runs or D1 is read. Every later decision uses the decoded path. Each management handler is also wrapped by `managementRoute`, which returns the unknown-API 404 when no administrator is attached, so the handlers do not depend on middleware path matching alone. Local development still serves escaped Vite module paths that are not management paths. |
| SEC-2: admin limiter bypass | Medium | Fixed | The same mismatch let an authenticated `/%61pi/...` request skip `ADMIN_LIMITER`. The canonical-path check refuses such requests, and the limiter keys off the canonical path, including the bare `/api`. |
| F2: Hono 4.13.13 advisories | Medium | Fixed | Upgraded to Hono 4.13.18. Release 4.13.16 resolved GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq, GHSA-3gg2-335m-rxc6, GHSA-46wx-v44x-9hh2 and GHSA-4h7h-rv7c-7m2v. Release 4.13.18 completed follow-up fixes: GHSA-92p4-j3wq-jmqx (validator), GHSA-39q9-qp46-w8xg (`bodyLimit`), GHSA-h25j-2p75-qj33 (`mount`) and GHSA-74fm-fwc7-3fwp (`serveStatic`). The application uses none of those four helpers. The release notes for 4.13.19 list no security advisories, so the newer, less-tested release was not needed. `bun audit` reports no vulnerabilities. |
| SEC-3: Fetch Metadata on management reads | Low | Fixed | After authentication, management API requests of any method are rejected with 403 when `Sec-Fetch-Site` is `cross-site` or `same-site`. The admin page, SPA routes and assets are exempt because the Access login flow returns cross-site navigations to them. |
| F5: no HSTS or HTTP redirect | Low | Fixed | Plain HTTP requests that reach the Worker for a configured hostname receive a 308 to the same path and query over HTTPS; Access or a zone rule may answer first. Worker responses over HTTPS carry `Strict-Transport-Security: max-age=31536000`, without `includeSubDomains` or `preload`, because other hostnames in the zone may not serve HTTPS. |
| F6: unlimited home-page D1 reads | Low | Fixed | The public limiter now covers `/`, including the preview hostname's `/`. Of the public requests that pass admission, only the static `/_health` is exempt. Requests refused during admission, such as unknown hosts, non-canonical paths, public management paths and unsupported methods, answer before the limiter without reading D1. The self-hosted fonts are served before the Worker runs. Public 429 responses now actually carry `Retry-After`; the header used to be set on the context and was lost. |
| F7: indexable redirects and home page | Low | Fixed in part | Worker responses without their own value carry `X-Robots-Tag: noindex, nofollow`, except redirects, which carry `noindex` alone so that no crawler reads `nofollow` as a reason not to follow a shortlink to a destination's own card. Search engines are not obliged to honour `X-Robots-Tag` on a redirect, so this asks rather than guarantees. A `robots.txt` disallow was not added: Twitterbot and LinkedInBot obey it and would stop rendering the documented sharing cards. |
| F4, SEC-4: crawler probe screening | Low | Fixed in part | Hostname comparisons in the probe and in destination validation now ignore any number of trailing dots. `localhost..` and `links.example.com..` therefore no longer bypass the suffix and self-reference checks. See the declined items for DNS resolution and caching. |
| SEC-5: verification accepted a Worker 401 | Low | Fixed | The admin page and each sampled management path must receive the Access login redirect of this deployment's application. That is a 302 to the team domain's `/cdn-cgi/access/login/<requested hostname>` with a single `kid` equal to `ACCESS_AUDIENCE`. Every other answer fails, with separate messages for a Worker rejection, another Access application, a `cf-mitigated` challenge and an inconclusive result. The sample covers `/api/links`, `/api/export`, `/api/settings`, `/api/session`, the nested `/api/links/verification-probe` and `/api/links/verification-probe/image`, `/assets/index.js` and `/assets/`. It cannot prove coverage of every path. Setup separately rejects destination overrides that would make a path public. An override added after setup, or a custom edge rule that imitates this login redirect, could still escape the sample; that residual risk is accepted for an HTTP-only check. The plain API paths must return 404 on the preview hostname whenever one is configured, and on the public hostname when administration uses a separate hostname. Encoded management paths must return 404 or that Access redirect on the public, preview and separate admin hostnames. A Node test checks that the mirrored Worker messages and HSTS lifetime still exist in `src/index.ts`. |
| SEC-6: deployment schema | Informational | Fixed in part | The deployment target schema requires `workers_dev: false` and `preview_urls: false`, as the deployment guide promises. The `/_fonts/*` asset bypass is unchanged; see the declined items. |
| F8: Access session and MFA | Low | Fixed in part | Setup creates the Access application with an eight-hour session and with Cloudflare One Client (WARP) authentication disabled. Reuse rejects an effective session longer than eight hours. A policy's own duration overrides the application's, so the application's duration is bounded only while some policy lacks an override. A missing or null application duration counts as Cloudflare's 24-hour default. Reuse also rejects unparsable durations and fractional components with more than nine digits. Shorter sub-nanosecond remainders, such as `0.1ns`, are truncated. It also rejects effective WARP authentication: the application's own value, or else the organisation's. The duration parser accepts a strict subset of Go durations in whole nanoseconds. MFA is documented rather than enforced; see the declined items. |
| F9: profiling and build artefacts | Informational | Fixed | The unauthenticated profiling renderer rejects titles and display names longer than the application's limits. The profiling script reserves title space for the largest sample suffix it adds. The token-protected profiling mutation endpoint now reads its body with the same bounded streaming reader as the Worker, `src/request-body.ts`, so it answers 413 before buffering an oversized body. Before migrations run, deployment removes `.dev.vars` and `.env` copies from the new build output. It also removes them from earlier retained outputs under `.wrangler/deployments/<UUID>/dist/worker`. A UUID-shaped name marks a candidate directory, every path component must be a real directory inside the checkout's own retained-output root, and deployment refuses to run if `.wrangler` or `.wrangler/deployments` is a symlink. Directories that disappear mid-sweep are skipped. Local `vite preview` builds under `dist/` keep their copy. |

## Declined findings

| Finding | Reason |
| --- | --- |
| F3: generated slugs have about 18 bits of entropy | Six-letter generated slugs are a deliberate, documented product behaviour, and `AGENTS.md` requires generation to start there. Shortlinks are made to be shared, and the public limiter bounds enumeration. The README now says short slugs are not secret. It also says a custom slug resists guessing only if it is long and random, and that confidential destinations need their own access control. One-character custom slugs are an administrator's choice. |
| F4, SEC-4: no DNS resolution or wildcard-DNS denylist | Only administrators choose destinations. The Workers runtime refuses subrequests to private networks, an assumption the README now states. The probe sends no credentials and returns only whether an image address exists. A denylist of wildcard DNS services cannot be complete, and resolving names in the Worker would still be open to rebinding. Destination servers choose their own redirect targets, which pass the same name checks. |
| SEC-4: uncached crawler probes | Spoofing a crawler user agent costs at most four bounded fetches to an administrator-chosen destination, under the public limiter. `AGENTS.md` requires recognised crawlers to probe destination HTML within fixed bounds. Its cache restriction concerns redirect and availability reads, so caching the probe's yes-or-no result would not breach it. Probing was left unchanged in this remediation. A separate crawler-probe budget is the preferred follow-up if such traffic becomes material. |
| F8: Access policy MFA | A `require` rule could lock administrators out, and it cannot be tested against live Access here. The deployment guide instead requires two-factor authentication on every administrator's Cloudflare account. Access independent MFA could be added later as a staged opt-in. |
| SEC-6: `/_fonts/*` bypasses the Worker | The fonts are fixed public files and the asset service matches paths exactly. HSTS reaches browsers through every Worker response. An edge rule could add headers if those assets must carry them too. |

## Independent review

GPT-6.2-Sol reviewed the first implementation at extra-high reasoning effort and found no Critical or High issue. Its findings and the follow-ups were:

| Review finding | Follow-up |
| --- | --- |
| Medium: generic 401/403 responses, empty 401s and redirects elsewhere on the team domain passed as Access | Only this application's login redirect for the requested hostname passes. Other answers fail with their own messages, and a wider sample of management paths is probed |
| Low: weak HSTS parsing, a preview host check that any 404 server could pass, a queryless HTTPS probe and no admin-host probe | Stricter HSTS parsing on public and preview health. Directive names and values must be tokens or quoted strings. `includeSubDomains` must be valueless, as RFC 6797 requires, and so must `preload`, by this verifier's own policy. Any comma, which could mean joined fields, is rejected, only spaces and tabs are trimmed, and one year is required. Also the Worker's health body, a `no-store` preview miss, and a query-preserving permanent redirect, also on the admin hostname |
| Low: WARP session precedence could bypass the eight-hour check | WARP authentication is disabled on creation and rejected on reuse |
| Low: Hono follow-up fixes after 4.13.16 | Upgraded to 4.13.18 |
| Info: duration parser grammar and boundary | Strict, documented subset in whole nanoseconds, with boundary tests |
| Info: profiling title reserve | Reserve derived from the sample count |
| Declined-item verdicts on `.dev.vars` and the profiling body read | Both fixed, as recorded above |
| Documentation scope | README, DEPLOY guide, state-machine reference and this record now distinguish Worker-local behaviour from edge behaviour |

A Claude Opus 5.5 review of those follow-ups added further changes, now in place:
- login redirects are bound to the application through `kid`;
- the HSTS parser validates directive names and allows whitespace around `=`;
- null Access fields are handled, with a test built from the response shape the live application returns;
- earlier retained outputs are swept;
- the plain API paths are probed on the preview hostname;
- negative tests assert their specific messages.

A second GPT-6.2-Sol round found no new route to management data and led to these changes:
- the retained-output sweep refuses symlinked components and unrecognised directories, and a third round extended this to `.wrangler` itself;
- setup rejects non-empty destination overrides and an enabled preflight bypass on the owned application;
- login redirects must name the requested hostname, and a missing `kid` is inconclusive;
- HSTS values are validated and an ambiguous combined header is rejected. A third round made any comma in HSTS or in an Access `Location` fail closed, made an empty `kid` inconclusive, and required a bare `no-store` without `must-understand`;
- miss probes check the `no-store` directive and use an unclaimable sentinel;
- the bounded reader uses one growing buffer and keeps its 413 if cancellation fails;
- the duration parser rejects fractional components with more than nine digits.

A fourth round probed encoded management paths on the separate admin hostname and treated cache-hit evidence on miss probes as a failure. It also accepted, as a residual risk, that the sweep trusts `.wrangler/deployments` as its own disposable namespace: a manually repurposed UUID-named tree, an operator-created mount, or a process with write access to the checkout replacing a directory after validation could still mislead it.

Two items were accepted as residual risk in the third round. The HTTP-only verifier samples paths and cannot detect an Access override added later or an edge rule imitating the login redirect. And a request stream whose cancellation never settles would delay a 413. The Worker reads the platform's own request body, and no stall was observed.

## Review by the original audits

Both original audit threads reviewed the final change set, with local probes only. Neither found a surviving bypass or a new security issue.

| Finding | Original verdict | Notes |
| --- | --- | --- |
| F1, SEC-1 | Satisfied | The original `/%61pi/*` probes, encoded line terminators, dot segments and double encoding returned 404 with no link data on every host layout |
| SEC-2 | Satisfied | A signed-assertion probe confirmed canonical API requests reach `ADMIN_LIMITER` and encoded variants are refused first. The suite's limiter test now also uses a signed assertion |
| F2 | Satisfied | Hono 4.13.18, clean `bun audit` |
| SEC-3, F5, F6, F9, SEC-5 | Satisfied | |
| F3 | Not fixed, by decision | Partly agreed: acceptable only as a documented risk acceptance. Suggested raising the initial length or a custom-slug minimum if destinations are sensitive |
| F4, SEC-4 | Partly fixed | Agreed with declining DNS resolution, denylists and caching. The platform's private-network refusal should be confirmed on staging |
| F7 | Partly fixed | Agreed with no `robots.txt` disallow. Raised that `nofollow` on redirects might deter a social crawler, so redirects now carry `noindex` alone |
| F8 | Partly fixed | Agreed with documenting MFA rather than forcing a `require` rule. Raised that the application's 24-hour default was applied even when a policy overrides it, so the effective duration is now bounded instead |
| SEC-6 | Partly fixed | Agreed with keeping the asset-first fonts |

## Regression coverage

| Fix | Tests |
| --- | --- |
| Canonical paths, route guard and limiter | `tests/worker.test.ts`: `Non-canonical path handling` (public, preview, separate-admin and same-origin hosts; local same-origin; escaped local modules; hidden public routes) and `Admin rate limiting on canonical paths`, including `limits authenticated canonical management requests and refuses their encoded variants before the limiter` with a signed Access assertion |
| Fetch Metadata | `tests/worker.test.ts`: `Fetch metadata on management reads`; `tests/auth.test.ts`: the `Sec-Fetch-Site` classification cases |
| HSTS and HTTPS redirects | `tests/worker.test.ts`: `Transport security headers` |
| Public limiter and `Retry-After` | `tests/worker.test.ts`: `Public rate limiting` |
| Robots directives | `tests/worker.test.ts`: `Robots directives` |
| Trailing dots | `tests/worker.test.ts`: `Trailing-dot hostnames`; `tests/links.test.ts`: `rejects self-referencing destinations however many trailing dots they carry`; `tests/social-preview.test.ts`: `never fetches restricted destinations or redirect targets` |
| Bounded body reads | `tests/request-body.test.ts`: `Bounded request body reader` |
| Access probes | `tests-node/operations-deploy.test.ts`: `verification accepts only a recognisable Access login redirect on the primary management path`; `verification rejects a login redirect that belongs to another Access application on the same team`; `verification probes the sampled management paths on a shared hostname`; `verification probes the sampled management paths on a separate admin hostname`; `verification applies Access probes to the separate admin host`; `verification probes encoded management paths on the public, separate admin and preview hosts`; `verification requires 404 for the plain management API paths on the public and preview hostnames`; `verification fails when an encoded management path is served` |
| Transport probes | `tests-node/operations-deploy.test.ts`: `Strict-Transport-Security parsing applies a strict RFC 6797 subset and requires one year`; `a joined pair of malformed Location fields is inconclusive even when it begins with this deployment's login`; `an uncached response needs a bare no-store directive and no must-understand`; `an uncached response fails on explicit cache-hit evidence and tolerates the other cache statuses`; `verification fails a no-store miss that a cache served on both hosts`; `verification requires exactly one valid HSTS field on the public and preview health responses`; `verification requires the Worker's health body and an uncached preview miss`; `verification judges the uncached miss by its no-store directive on both hosts`; `the unknown-shortlink sentinel can never be claimed as a custom slug`; `verification requires a permanent HTTPS redirect that preserves the query string`; `verification accepts an HTTPS redirect or the Access login for plain HTTP on the admin hostname` |
| Source mirrors | `tests-node/operations-deploy.test.ts`: `verification probes mirror the rejection messages and HSTS lifetime in the Worker source`; `profiling limits mirror the contract limits in shared/contracts.ts` |
| Deployment schema and artefacts | `tests-node/operations-deploy.test.ts`: `deployment configuration requires workers.dev and preview URLs to be disabled`; `local-only variable files are removed from the generated Worker before migration while the rollback configuration remains`; `local-only variable files are swept from the Worker output of earlier retained deployments`; `the retained-output sweep never follows a symlinked deployment, dist or worker directory out of the retained root`; `a symlinked .wrangler or .wrangler/deployments refuses deployment and leaves the other checkout's local variables intact`; `a retained deployment that disappears during the sweep is skipped` |
| Access session lifetime | `tests-node/operations.test.ts`: `Access session duration may not exceed the duration used by setup`; `a policy session duration overrides the application's when bounding the effective session`; `Access session duration boundary is exact to the nanosecond and rejects finer fractions`; `the application shape Cloudflare returns validates when WARP authentication is unset or disabled`; `null Access durations and WARP settings are treated as unset`; `Access application may not allow authentication through the Cloudflare One Client`; `Access application may not carry destination overrides or the preflight bypass` |
| Profiling bounds | `tests-node/operations.test.ts`: `profiling title reserve follows the largest suffix the sample count produces` |

With the Worker fix reverted, 13 of the new Workers tests failed. Adversarial local reviews also tried double and mixed-case encoding, encoded slashes, dot segments, backslashes, encoded line terminators, invalid UTF-8, path parameters, HEAD and unusual methods. They also tried Origin and Fetch Metadata combinations, signed JWTs, and open-redirect attempts through the HTTPS upgrade, on every host layout. None reached management data or skipped the limiter.

GPT-6.2-Sol reviewed the change set five times in all. Its fifth and final round found no remaining defect that needs fixing before staging. It judged the change set ready for a staging deployment, with live setup reuse, the three-host verifier run and the authenticated browser flow still to confirm before production.

## Verification record and remaining limits

`bun install --frozen-lockfile`, `bun run verify` and `bun audit` passed locally. That covers type checks, 224 Workers/D1 tests, 61 Node script tests, 17 browser tests and the production build. `bun audit` found no vulnerabilities in 295 packages.

The fixes have not been published. These checks need an authorised deployment, preferably to staging first:

- Run `bun run verify:deployment`. It now also checks HTTPS enforcement, this application's Access login redirects and the encoded management paths. Its Access checks follow the login URL format Cloudflare's own Access plugin generates, which has not been observed directly from this deployment.
- Record whether Cloudflare's edge normalises `/%61pi/links` before the Worker sees it, and confirm the unauthenticated result is a 404 or the Access login redirect. The original bypass was reproduced only in local workerd; either edge behaviour is safe with the fix in place.
- Rerun `bun run setup` against the existing Access application to confirm that its live response passes the stricter reuse checks, including the organisation's WARP setting.
- Complete the authenticated browser flow in `DEPLOY.md`, including that the admin panel's API calls still succeed with the Fetch Metadata check.
- Share a shortlink whose destination advertises its own Open Graph image, and one whose destination does not, in at least one real sharing service. Confirm the first keeps its own card and the second shows the generated card.
- Optionally, point a staging link at a hostname that resolves to a private address, such as `127.0.0.1.nip.io`, and confirm with a crawler user agent that the probe does not reach it. This confirms the platform's private-network refusal that the probe relies on.
