# Ratatoskr state machines

This reference records the application and operational state machines audited on 9 November 2026. The baseline is commit `e6363768c90d7eca88c028683a0d18e1a6e294e1` plus the then-uncommitted home redirect changes. Those changes were preserved and committed separately as `c1c433e` before the audit fixes.

The tables describe the implemented state machines. The issue evidence preserves the original, reproduced failures and distinguishes executed reproductions from concrete source schedules. An **invariant** states the rule the implementation enforces. A type that permits an invalid combination is not, by itself, evidence that the application can reach it.

All seven issue groups are implemented, locally verified and published. After the independent review and follow-up fixes, `bun install --frozen-lockfile` and `bun run verify` passed: type checks, 181 Workers/D1 tests, 26 Node tests, 17 browser tests, and the production build. Claude Opus 5.5 reviewed the design and implementation with fast mode disabled; its four low-severity findings are resolved below. The baseline verification passed 168 tests, type checks, and the production build. Production deployment and data-preservation checks are recorded below; the authenticated browser flow remains unverified.

## Issue register

| Priority | Issue | Baseline failure | Impact | Status |
| --- | --- | --- | --- | --- |
| High | [SM-1](#sm-1-deployment-target-and-build-consistency) | Setup can leave inconsistent deployment files, deployments share build output, and hyphenated names select the wrong output path | Migrate the wrong database or fail publication after a successful build | Implemented and locally verified |
| Medium | [SM-2](#sm-2-access-application-reuse) | Setup accepts incomplete management domains and conflicting Access policy fields | Missing edge protection or administrator lockout, without a demonstrated Worker authentication bypass | Implemented and locally verified |
| Medium | [SM-3](#sm-3-preview-binary-integrity) | Upload schema accepts compressed sections that cannot form a valid PNG | Break one link image or every generated image through custom branding | Implemented and locally verified |
| Medium | [SM-4](#sm-4-mutation-retries-and-audit-semantics) | Creation lacks retry identity, deletion retry reports failure, and mixed PATCH audit labels can be wrong | Duplicate aliases, failed recovery, or inaccurate audit history | Implemented and locally verified |
| Medium | [SM-5](#sm-5-independent-settings-edits) | Settings submits stale fields the administrator did not change | Silently revert another administrator's name, header, or home redirect | Implemented and locally verified |
| Medium to low | [SM-6](#sm-6-ui-request-ownership-pending-drafts-and-expiry) | Obsolete requests publish results, pending drafts remain editable, and expiry has no clock-driven render | Missing or wrong rows, discarded edits, stale availability labels | Implemented and locally verified |
| Low | [SM-7](#sm-7-telemetry-refresh) | An events-only refresh replaces saved evidence with empty collections | Lose the client samples and invocation evidence being refreshed | Implemented and locally verified |

The groups are tracked in GitHub: [SM-1, issue 3](https://github.com/itsvari/ratatoskr/issues/3), [SM-2, issue 4](https://github.com/itsvari/ratatoskr/issues/4), [SM-3, issue 5](https://github.com/itsvari/ratatoskr/issues/5), [SM-4, issue 6](https://github.com/itsvari/ratatoskr/issues/6), [SM-5, issue 7](https://github.com/itsvari/ratatoskr/issues/7), [SM-6, issue 8](https://github.com/itsvari/ratatoskr/issues/8), and [SM-7, issue 9](https://github.com/itsvari/ratatoskr/issues/9). The issue details preserve the original failure trace after a fix so that its regression test has a stated purpose. Implementation commits separate storage invariants, deployment isolation, profiling recovery and admin request ownership; the issue records track their publication and verification.

## Runtime ownership

| Owner | State and decisions |
| --- | --- |
| [shared/contracts.ts](../shared/contracts.ts) | API schemas, persisted-status vocabulary, request and response shapes |
| [src/configuration.ts](../src/configuration.ts), [src/auth.ts](../src/auth.ts) | Allowed origins, local-mode eligibility, JWT verification, mutation admission |
| [src/index.ts](../src/index.ts) | Host and HTTP routing, bounded bodies, request-local settings reads, public availability decisions |
| [src/links.ts](../src/links.ts), [src/slugs.ts](../src/slugs.ts) | Link lifecycle, atomic claims and audits, pagination, generation and collision growth |
| [src/settings.ts](../src/settings.ts), [migrations](../migrations) | Settings and branding transactions, database constraints and preview withdrawal |
| [src/preview-image.ts](../src/preview-image.ts), [src/preview-segment.ts](../src/preview-segment.ts), [shared/preview-image.ts](../shared/preview-image.ts), [src/png.ts](../src/png.ts) | Stored image sections, bounded write-time validation, current availability, PNG assembly |
| [src/social-preview.ts](../src/social-preview.ts) | Bounded, credential-free crawler metadata probes |
| [admin/main.tsx](../admin/main.tsx), [admin/api.ts](../admin/api.ts) | Session, queries, forms, commands, notices, and browser request lifecycle |
| [admin/appearance.ts](../admin/appearance.ts), [admin/preview-image.ts](../admin/preview-image.ts) | Appearance persistence and browser renderer resources |
| [scripts](../scripts) | Provisioning, deployment, verification, fixture cleanup, and profiling reports |

## Configuration and request admission

### Configuration and host classification

`loadConfiguration` produces a production or local configuration, or rejects the configuration. The request then belongs to the short origin, admin origin, optional preview origin, or no configured origin. Admin and short origins may coincide. Preview origin must differ from both.

Sources: [src/configuration.ts](../src/configuration.ts), `loadConfiguration`. [src/index.ts](../src/index.ts), middleware, `isAdministrationPath`, and `isLocalAssetPath`.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| Unvalidated configuration | Invalid origin, missing production Access settings, or conflicting preview origin | Rejected |
| Unvalidated configuration | Local flag is true and configured admin origin is HTTP loopback | Local configuration |
| Unvalidated configuration | Otherwise valid settings | Production configuration with local authentication disabled |
| Configured | Request origin is outside configured origins | 404 |
| Allowed origin | GET or HEAD of a fixed public font path | Static font response |
| Short origin with separate admin | `/admin` or a child path | Redirect to the configured admin origin |
| Admin origin | Separate admin host, management path, or eligible local asset | Management admission |
| Public or preview origin | Management path | 404 |
| Public or preview origin | Method other than GET or HEAD | 405 |
| Public or preview origin | Other allowed request | Public dispatch |

Invariant: a separate admin host keeps public-host `/api/*` inaccessible. The fixed font exception exposes no management operation. Production cannot enable the local identity merely by setting `LOCAL_DEVELOPMENT=true` on an HTTPS origin.

### Management admission and signing keys

`authenticate` returns an administrator or null. Each request rechecks its assertion. An issuer-scoped `jose` resolver caches signing keys, not an authorised session. Resolver state is absent, fetching, fresh, stale, or failed.

Sources: [src/auth.ts](../src/auth.ts), `authenticate` and `acceptsMutation`. [src/index.ts](../src/index.ts), management middleware. Resolver retry behaviour was checked in the installed `jose` implementation.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| Management request | Eligible local mode and exact configured admin origin | Local administrator |
| Management request | Missing assertion | 401 |
| Assertion present | No resolver for issuer | Create resolver, then verify |
| Verifying | RS256 signature, issuer, audience, required claims, expiry, and email allowlist pass | Authorised administrator |
| Verifying | Any validation or key-fetch failure | 401, no mutation |
| Authorised mutation | Origin is not the exact admin origin, or Fetch Metadata rejects the request | 403 |
| Authorised production API request | Management limiter denies | 429 with `Retry-After` |
| Authorised request | Remaining checks pass | Handler |
| Failed resolver fetch | A later request verifies | Dependency retries the fetch |

No authentication bypass was confirmed. The installed dependency clears pending fetch state after completion and prevents an obsolete overlapping refresh from replacing newer keys.

### Request body, settings lookup, and errors

Sources: [src/index.ts](../src/index.ts), `parseBody`, `readSettings`, `unavailable`, and the error handler.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| Awaiting JSON body | Wrong content type | 415 |
| Awaiting JSON body | No reader | 400 |
| Reading bytes | Route cap exceeded | Cancel body and return 413 |
| Reading bytes | End of body | Decode unknown JSON |
| Decoded JSON | JSON or schema is invalid | 400 |
| Schema-valid request | Handler succeeds | Route response |
| Handler fails | `ApplicationError` | Declared status and safe message |
| Handler fails | Other error | 503, with error category only in production logs |
| Settings unread in this request | First `readSettings` call | Cache one pending promise in the request context |
| Pending settings read | Success or failure | Same outcome shared within this request |
| Error page needs settings | Settings read fails | Use default display name |

Link bodies are capped at 8,192 bytes. Image and settings bodies are capped at 128 KiB. A rejected settings promise cannot poison a later request. Write-time compressed-section validation runs after wire-shape validation and before persistence.

## Links and stored settings

### Persisted link lifecycle and availability

Persisted states are absent, active, revoked, and deleted. Expiry is a clock predicate rather than another database status. Active and revoked rows can each be unexpired or expired. Null expiry means no time limit.

Sources: [src/links.ts](../src/links.ts), `createLink`, `updateLink`, `deleteLink`, and `getLink`. [0001_initial.sql](../migrations/0001_initial.sql). [src/index.ts](../src/index.ts), public handler.

| From | Event | Next state and effect |
| --- | --- | --- |
| Absent | Valid custom or generated creation wins atomic claim | Active row and one create audit |
| Any existing row, including deleted | A different command claims the same custom slug | Unchanged, 409 |
| Active or revoked | Patch changed title, destination, or expiry | Same persisted status, supplied fields changed, one audit |
| Active | Revoke | Revoked, one audit |
| Revoked | Restore | Active, expiry unchanged |
| Active or revoked | Repeat identical patch | Unchanged, no audit |
| Active or revoked | Clock reaches expiry | Same row, expired derived state |
| Expired live row | Clear expiry or set a future expiry | Unexpired derived state, persisted status unchanged |
| Active or revoked | Delete | Tombstone with empty title, null destination, null expiry, one audit |
| Deleted | Patch or restore | Unchanged, 404 |
| Deleted | Delete again, including concurrent retry | Success without another delete audit |
| Absent | Delete | 404 |
| Deleted | Read, list, or export | Hidden |
| Active and unexpired | Public lookup | Eligible to redirect or preview |
| Revoked or expired | Public lookup | 410 |
| Absent or deleted | Public lookup | 404 |

The database enforces permanent unique slug claims and erased tombstone content. Mutation, administrator upsert, and audit share a transaction. Audit failure rolls them back. Update audits select the actual old status before the mutation. The following UPDATE runs only when that audit insertion changed a row, so no-op patches remain unaudited. Deletion and editing cannot resurrect a tombstone in either transaction order. Independent field PATCHes survive concurrency. Two explicit writes to the same field retain last-write-wins semantics.

Restoring an expired row does not extend its expiry. The row stays unavailable until its expiry changes. Availability checks use primary D1 reads and do not write click counters.

### Creation receipts and replay

Sources: [src/links.ts](../src/links.ts), `createLink`, `insertLink`, and `classifyReceipt`. [0005_creation_requests.sql](../migrations/0005_creation_requests.sql). The optional UUID `requestId` identifies one command within an administrator subject. A receipt stores the claimed slug and SHA-256 hash of the canonical destination, trimmed title, normalised custom slug, and canonical expiry.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| No receipt | Valid keyed command claims a free slug | Link, create audit, and receipt commit in one transaction |
| No receipt | Generated candidate collides | No receipt, bounded allocation continues |
| No receipt | Custom slug collides | 409, no receipt |
| No receipt | Link, audit, or receipt write fails | Transaction rolls back all changes |
| Matching live receipt | Same actor, UUID, and canonical payload | HTTP 201 with the current link, without another creation |
| Matching live receipt | Payload differs | 409, no mutation |
| Matching receipt | Current expiry elapsed or deployment host settings changed | Recognise the earlier command before fresh-allocation checks |
| Receipt's link | Later title, destination, status, or expiry edit | Retain original command hash, replay returns the current live row |
| Receipt's link | Deletion | Keep actor, UUID, and reserved slug, clear request hash in the same transaction |
| Deleted receipt | Any replay | 409 before hash comparison, never recreate |
| Same UUID | Different administrator subject | Independent command |
| No requestId | Create | Independent operation, no replay guarantee |

Invariant: simultaneous identical keyed commands produce one link, one receipt, and one create audit. A receipt never commits without its link. The delete trigger erases the destination fingerprint as well as the link content. Receipts do not expire and are not a response-body cache. Replays after a later edit expose current data rather than the original creation snapshot. Browser reloads or abandoned forms lose their in-memory identity, so a new form is a new command.

### Generated allocation and screening

State consists of a persisted starting syllable count, a request-local count, collision attempts, and screening attempts. The starting count is three syllables. The maximum is 24, or 48 characters.

Sources: [src/slugs.ts](../src/slugs.ts), `generateSlug`, `isSafeGeneratedSlug`, and `parseCustomSlug`. [src/links.ts](../src/links.ts), `createLink`.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| Need candidate of N syllables | Complete candidate passes screening | Attempt atomic insertion |
| Screening | 32 rejected candidates | Generate bounded safe fallback, then attempt insertion |
| Insertion | Unique slug | Active row and create audit |
| Collision | Fewer than eight attempts at N and fourteen total | Generate another candidate at N |
| Eight collisions at N | Budget remains and N is below 24 | Persist `MAX(value, N + 1)` and try the next length |
| Allocation | Fourteen attempts, or all attempts at maximum length fail | 503 without a link or create audit |
| Concurrent growth | Multiple allocators update the starting count | Persisted count never decreases |

Screening covers complete strings and approximate pronunciations. It does not promise neutrality in every language. Custom slugs remain administrator-chosen. An in-flight allocator can finish at its original length after another request increases the starting count. A failed request may leave a larger starting count. Both are valid states.

### Pagination, search, and export

Sources: [src/links.ts](../src/links.ts), `parseCursor`, `listLinks`, and `exportLinks`.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| No cursor | Valid search and optional status filter | First page from primary D1 |
| Cursor supplied | Excessive length, invalid encoding, or invalid JSON shape | 400 |
| Valid cursor | Query continues | Rows strictly below the `(createdAt, slug)` boundary |
| Query returns at most fifty rows | Build page | Rows and null next cursor |
| Query returns a fifty-first row | Build page | Fifty rows and a cursor from the last returned row |
| Export requested | Primary SELECT completes | Current live rows, excluding tombstones |

Search treats `%`, `_`, and backslash literally. Ordering is creation time descending, then slug descending. Edits do not change that order. A cursor does not identify an immutable database snapshot or bind itself to filters. Concurrent inserts, deletions, and filter-changing edits can change later results. Mixing query generations in the UI is separately covered by SM-6.

### Shared settings and branding

The aggregate is `{displayName, homeRedirectUrl, previewHeader}`. Branding is default with a bundled header, or custom with a stored header. The home page independently shows built-in HTML or redirects to a stored external URL.

Sources: [shared/contracts.ts](../shared/contracts.ts), `siteSettingsSchema` and `updateSiteSettingsSchema`. [src/settings.ts](../src/settings.ts), `getSiteSettings` and `updateSiteSettings`. [0002_preview_images.sql](../migrations/0002_preview_images.sql), [0003_site_settings.sql](../migrations/0003_site_settings.sql), and [0004_home_redirect.sql](../migrations/0004_home_redirect.sql).

| From | Event | Next state and effect |
| --- | --- | --- |
| Default branding | Save custom name and header | Custom pair and one settings audit |
| Custom branding | Save another custom name and header | Replace pair atomically |
| Custom branding | Save default name | Default name and null stored header |
| Built-in home | Save external home URL | Public root redirects |
| Redirecting home | Clear URL | Built-in home |
| Any settings | Patch repeats the supplied values | No settings, header, or audit mutation |
| Any settings | Empty patch, header without a name, invalid input, or missing custom header | 400, unchanged |
| Any settings | Audit failure | Entire settings transaction rolls back |
| Any settings | Home-only patch | Change or clear URL, preserve name and header |
| Any settings | Name-only patch | Change name and header together, preserve home URL |
| Concurrent editors | Save different fields | Both changes survive, each audit records the resulting complete settings |

Name and header change atomically with the audit. Display names are plain text and are escaped in HTML and SVG. Home URLs must use HTTP or HTTPS without credentials and cannot target the shortener's hosts. Normal shortlink redirects do not load settings.

Invariant: omitted fields keep their current values. The browser sends only fields changed from its opening snapshot, and generates a header only for a supplied custom name. A supplied default name restores the bundled header and ignores any otherwise schema-valid uploaded header. Header-only writes are rejected. External clients that explicitly supply stale values still request those values, and same-field writes retain last-write-wins semantics.

## Public resolution and previews

### Public route selection

Source: [src/index.ts](../src/index.ts), public handler. Link availability comes from the lifecycle table above.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| Public route other than root or health | Public limiter denies | 429 without link lookup |
| Short-origin root | Home URL is null | Built-in home page |
| Short-origin root | Home URL is present | 302 to stored URL |
| Preview-origin root | Any settings | 404 |
| Active link | `+` suffix or preview hostname | Stored-data HTML preview, no destination fetch |
| Active plain link | Ordinary user agent | Immediate 302 |
| Active plain link | Recognised social crawler | Metadata probe |
| Metadata probe | Usable image metadata found | 302 to the original stored destination |
| Metadata probe | Missing metadata, rejected target, error, or timeout | Stored-data HTML preview |
| Image path | Valid slug | Stored-image lifecycle below |

New lookups use primary D1 and responses use `Cache-Control: no-store`. User-agent-dependent responses include `Vary: User-Agent`. A request that already read an active row can complete after a concurrent revocation, edit, or expiry. The read is that request's availability snapshot. Previously delivered redirects and third-party cached cards cannot be recalled.

### Crawler metadata probe

Sources: [src/social-preview.ts](../src/social-preview.ts), `isPreviewCrawler`, `canFetchMetadata`, `readMetadata`, and `destinationHasPreviewImage`.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| Target validation | Malformed URL, credentials, unsupported scheme or port, IP literal, internal name, or own hostname | Fallback without fetching target |
| Allowed target | Start or allowed redirect hop | Credential-free fetch with manual redirects |
| Fetching | Redirect with Location and remaining hop budget | Resolve and validate the next target |
| Fetching | Another redirect after three followed redirects | Fallback, at most four fetches |
| Fetching | Failure status or non-HTML content | Cancel body and fallback |
| Reading HTML | End of body or 65,536-byte prefix | Cancel body and parse prefix |
| Probe pending | Two-second timeout | Abort, then fallback |
| Parsing HTML | Recognised image property contains a non-empty HTTP or HTTPS URL | Image metadata found |
| Parsing HTML | No usable property | Fallback |
| Any terminal outcome | Return or error | Clear timeout |

Each probe owns its controller and counters. No visitor credentials are forwarded. Neither destination images nor favicons are fetched. The probe validates names and IP literals, not independently resolved DNS addresses. No reachable private-network response was established in this audit. Timeout behaviour assumes runtime fetch honours its abort signal.

### Stored preview bodies and custom headers

Sources: [src/preview-image.ts](../src/preview-image.ts), `storePreviewImage` and `renderPreviewImage`. [src/png.ts](../src/png.ts), `assemblePreviewPng`. [shared/preview-image.ts](../shared/preview-image.ts). [0002_preview_images.sql](../migrations/0002_preview_images.sql).

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| Live link | Validated upload matches current title, destination, and configured short origin | Upsert stored body |
| Missing or deleted link, or stale title or destination | Upload | 409, no replacement |
| Stored body | Title or destination changes, or link is deleted | SQL trigger withdraws body atomically |
| Stored body | Revoke, restore, or expiry changes | Body may remain. Current availability controls access |
| Image request | Missing or deleted link | 404 |
| Image request | Revoked or expired link | 410 |
| Active image request | No body matching current link and origin | 503 with `Retry-After` |
| Active matching body | HEAD | 200 without assembly or decoding |
| Active matching body | GET | Join current header and body, then return 200 |
| Default branding | Image assembly | Use bundled header |
| Custom branding | Image assembly | Use stored header |
| Body or custom-header upload | Invalid base64, deflate boundary, decoded length, row filter, checksum, or output limit | 400 before image, settings, or audit mutation |
| Body or custom-header upload | Valid composable section | Continue to conditional storage or settings transaction |

Concurrent upload and edit are safe in both orders: upload-before-edit is withdrawn, and edit-before-upload is rejected. Identical upload retries replace one row. Deletion prevents later uploads from restoring image data.

Invariant for new writes: every stored section has the expected decoded size, filter-zero scanlines, checksum, and composable deflate boundary. [src/preview-segment.ts](../src/preview-segment.ts), `validatePreviewSegment`, requires canonical base64, a sync-flush suffix, exact input consumption after the shared final block, bounded inflation, and exact output length. Public reads do no decompression. Older corrupted rows remain possible until an administrator regenerates them or saves valid branding.

### Renderer and font resources

Sources: [admin/preview-image.ts](../admin/preview-image.ts), browser preparation and generation functions. [src/preview-wasm.ts](../src/preview-wasm.ts), `createSvgRenderer`. [src/preview-renderer.ts](../src/preview-renderer.ts), `createPreviewRenderer`.

| Resource | From | Event | Next state and effect |
| --- | --- | --- | --- |
| Browser Wasm, main font, fallback font | Unloaded | First request | Pending promise shared by callers |
| Browser preparation | Pending | Success | Ready and cached |
| Browser preparation | Pending | Failure | Rejected entry removed, later attempt may retry |
| Browser main font | Failed after Wasm succeeded | Retry | Reuse ready Wasm and reload font |
| Resvg renderer or rendered image | Allocated | Success or exception | Freed in `finally` |
| Bundled Worker/test Wasm | Uninitialised | First request | One pending initialisation promise |
| Bundled Worker/test Wasm | Pending | Success | Ready |
| Bundled Worker/test Wasm | Pending | Rejection | Rejected promise remains cached |

The current public image route joins stored sections and does not run Wasm or keep a rendered-image cache. The retained rejected promise in the bundled renderer affects test, profiling, and generation paths. No repeatable transient failure was demonstrated there, so it is a documented limit, not a ranked bug.

## Admin interface

### Session and API request lifecycle

Sources: [admin/main.tsx](../admin/main.tsx), `App` and `loadSession`. [admin/api.ts](../admin/api.ts), `request`, `readJson`, `fetchSession`, and `isAbortError`.

`SessionState` explicitly represents loading, ready with validated session data, expired, and failed with a message. A request separately progresses through sending, body consumption, parsing, and a terminal result.

| From | Event | Next state and effect |
| --- | --- | --- |
| Loading session | Valid current response | Ready, Workspace mounts |
| Loading session | 401 or opaque login redirect | Expired |
| Loading session | Transport or schema failure | Failed with retry |
| Failed session | Retry | Loading |
| Ready session | Management call reports session expiry | Expired, Workspace unmounts |
| Sending request | Successful headers | Read body |
| Reading body | Valid schema | Return domain payload |
| Sending request | Abort | AbortError retained |
| Reading successful or error body | Abort | AbortError retained |
| Obsolete session request | Completion after abort or replacement | Ignore success and failure through controller ownership checks |

Invariant: an aborted or superseded request publishes neither data nor an error. Session completion checks both controller identity and its abort signal. Session expiry aborts the outstanding owner before unmounting Workspace. API body parsing preserves cancellation identity for successful and unsuccessful responses.

### Search, first pages, and pagination

Sources: [admin/main.tsx](../admin/main.tsx), `Workspace`, `useDebouncedValue`, `invalidate`, `refresh`, `loadMore`, and `handleCreated`.

The UI has a draft search value, a 250-ms debounced value, and an all/active/revoked filter. `ListState` is loading, failed, or ready with a generation, rows, a cursor, and `loadingMore`.

| From | Event | Next state and effect |
| --- | --- | --- |
| Any list state | Query, filter, or retry changes | Increment generation, abort old reads, start first-page load |
| Loading | Current first-page success | Ready with that generation's rows and cursor |
| Loading | Current first-page failure | Failed, or expired session if authentication ended |
| Any state | Obsolete read success or failure | No publication |
| Ready with current cursor | Load more | Ready with `loadingMore=true` and one continuation owner |
| Loading more | Current page succeeds | Append deduplicated rows, replace cursor, clear pending state |
| Loading more | Current page fails | Preserve rows and cursor, clear pending state, permit retry |
| Any state | Mutation succeeds | Synchronously invalidate reads and refresh the current first page |
| Loading | Create succeeds before older read completes | Older completion is ignored, refreshed query includes committed state |
| Ready search results | Edit changes searchable content | Refetch current query, so rows entering or leaving the match are reconciled |

Invariant: rows, cursor, and page requests belong to one current query generation. A request checks its generation, controller identity, and abort signal before publishing. Mutations synchronously invalidate both read owners, then refresh the current query from its first page. This deliberately resets loaded pagination after a successful mutation.

### Dialogs and pending commands

Sources: [admin/main.tsx](../admin/main.tsx), `CreateDialogContent`, `EditDialogContent`, `SettingsDialogContent`, confirmation content, and `busyGuards`.

Workspace keeps independent creating, editing, confirmation, and settings selections. Normal modal interaction prevents ordinary overlapping dialogs. Representable combinations alone are not confirmed failures.

| From | Event | Next state and effect |
| --- | --- | --- |
| Closed | Open dialog | Draft or confirmation for selected entity |
| Editing | Invalid submit | Draft with validation error, no mutation |
| Editing or confirming | Valid submit | Pending command with captured payload |
| Pending | Escape, outside click, Close, or Cancel | Busy guards keep the dialog open |
| Pending create or edit | User tries to edit a field or clear expiry | Inputs and Clear are disabled |
| Pending settings | User tries to edit a field | Inputs are disabled |
| Pending | Success | Create result or closed dialog |
| Pending | Failure | Error and editable draft for retry |
| Pending | Session expiry | Workspace unmounts |
| Create result | Create another | Fresh draft |
| Create result | Done | Close dialog |

Edit and settings send only fields changed from their opening snapshots. Creation retains the typed submitted command and its UUID for an unchanged visible draft after an ambiguous response. A changed draft or a new form gets a new identity after fresh validation. The identity belongs to this form instance and is not persisted across reload or closing the form. If no earlier creation committed, the server still rejects a newly expired command.

Invariant: the visible draft stays equal to the submitted command while that command is pending. Failed submissions restore editability without discarding the draft. An unchanged retained command bypasses fresh-form future-expiry validation, so a lost-response retry remains possible after its submitted expiry. A changed draft or new form must still pass future-expiry validation.

### Link commands and preview work

Sources: [admin/main.tsx](../admin/main.tsx), `regeneratePreview`, `handleCreated`, `restoreLink`, and `confirmPending`. [admin/api.ts](../admin/api.ts), `saveLinkPreview` and `saveSiteSettings`.

| From | Event | Next state and effect |
| --- | --- | --- |
| Idle | Create or edit succeeds | Persisted link, detached preview operation starts |
| Preview pending | Current session fetched | Prepare local renderer with current short origin |
| Renderer ready | Render and compress snapshot | Upload body for captured title and destination |
| Upload | Server accepts current snapshot | Preview ready notice |
| Any preview phase | Failure | Persisted link remains, image regeneration is offered |
| Image unavailable | Regenerate | Start another preview operation |
| Settings draft | Save custom-name patch | Generate header before atomic settings request |
| Settings draft | Save URL-only or default-name patch | Send patch without rendering a header |
| Restoring or revoking | API succeeds | Invalidate list, refresh current query, announce success |
| Deleting | API succeeds | Invalidate list, refresh current query, announce success |
| Deleting after lost successful response | Retry acknowledges existing tombstone | Refresh list and announce success without another delete audit |

Concurrent preview generation is permitted. The server's snapshot comparison and withdrawal trigger determine which body remains usable. An image failure does not roll back a saved link.

### Appearance and small UI lifecycles

Sources: [admin/appearance.ts](../admin/appearance.ts), `readStoredAppearance`, `applyAppearance`, and `useAppearance`. [admin/main.tsx](../admin/main.tsx), notices, `copyToClipboard`, export handler, `StatusBadge`, `ExpiryText`, and `isExpired`.

| Machine | From | Event | Next state and effect |
| --- | --- | --- | --- |
| Appearance | Startup | Valid stored dark, light, or system | Apply preference and resolved colour |
| Appearance | Startup | Missing, invalid, or inaccessible storage | Default dark |
| Appearance | Any preference | Explicit choice | Apply immediately, persist best effort |
| Appearance | System preference | Media query changes | Recompute colour, keep system preference |
| Appearance | Any preference | Matching storage event | Follow stored preference across tabs |
| Appearance | Any preference | External `localStorage.clear()` | Null-key event is ignored currently |
| Notice | Empty or visible | New notice | Replace with new monotonic ID and restart six-second timer |
| Notice | Visible | Dismiss or timeout | Empty |
| Clipboard | Idle | Copy | Pending, then success or failure notice |
| Export | Idle | Export | Busy, then downloaded result or error |
| Download URL | Created | Download triggered | Revoke after one second |
| Row expiry | Active or revoked before expiry | Nearest visible expiry timer fires | Refresh shared clock and expiry text; a revoked badge remains Revoked |
| Row availability | Tab was hidden or unfocused | Visibility or focus event | Refresh shared clock from current time |
| Row availability | Revoked | Any expiry | Revoked label takes precedence |

The app never calls `localStorage.clear()`, so its null-key event gap is an externally induced limitation, not a prioritised app bug. `LinkList` owns one expiry timer and passes the same timestamp to desktop and mobile rows. Each render also uses the current wall clock, so a delayed page cannot display a link as active after expiry. Timer delays are capped at 2,147,483,647 ms, then recalculated. Browser regressions passed for appearance persistence, layout widths and expiry. Desktop, mobile, light, pending and error screenshots were also inspected.

## Operations

### Setup and resource reuse

Sources: [scripts/setup.ts](../scripts/setup.ts), provisioning sequence. [scripts/deployment-access.ts](../scripts/deployment-access.ts), `findExistingApplication` and `validateApplication`. [scripts/deployment-configuration.ts](../scripts/deployment-configuration.ts), `atomicWrite`.

| From | Event or guard | Next state and effect |
| --- | --- | --- |
| Start | Invalid domain, name, or account | Stop before requested-zone resources are created |
| Authenticated | Requested account belongs to identity | Account selected |
| Account selected | Exact active zone found | Zone validated |
| Zone validated | Access application summaries loaded | Inspect public destinations across all application types and compare coverage |
| Application inspection | Multiple names, conflicting destinations, or another app overlaps management paths | Reject without replacing another app |
| Application inspection | Private destination or application without a public destination | Ignore that destination during other-application overlap checks; own-app validation remains strict |
| Application inspection passes | Restricted provider exists | Reuse provider |
| Application inspection passes | Provider missing | Create provider, or stop on failure |
| Provider ready | Expected app exists | Fetch full policy and validate exact coverage and policy |
| Provider ready | App absent | Create expected app, then validate the response by the same rules |
| Access validated | Named D1 database exists | Reuse database |
| Access validated | Database absent | Create with replication disabled |
| Database ready | Publish configuration | Atomically replace canonical configuration, then atomically replace inventory |
| Any side-effect phase | CLI or disk failure | Stop with partial remote state or complete old/new local files |
| Failed setup | Same options retried | Rediscover completed resources and validate before reuse |

Effective destinations support current `destinations[].uri`, legacy `self_hosted_domains`, and a singleton `domain`. Non-empty conflicting representations reject. The policy must have one allow rule, exactly the requested emails and identity provider, and no exclusions or requirements. Hostnames and root forms are normalised. Non-root path case and wildcard semantics remain distinct. Overlap detection rejects broader and narrower literal paths at segment boundaries, and conservatively rejects wildcard coverage. A separate literal path such as `/administrator` does not overlap `/admin`.

The configuration and inventory can still represent different setup runs after interruption. Only `wrangler.deploy.json` selects deployment targets, so inventory drift cannot redirect a deployment. No shared remote resource is rolled back automatically. Concurrent creation can leave duplicates or return API conflicts. Retries validate ownership and policy instead of silently replacing resources.

### Deployment inputs and artefacts

Sources: [scripts/deploy.ts](../scripts/deploy.ts), publication sequence. [scripts/deployment-configuration.ts](../scripts/deployment-configuration.ts), `readDeploymentTarget` and `validateGeneratedTarget`. [vite.config.ts](../vite.config.ts), private output and fixed `worker` build environment.

| From | Event | Next state and effect |
| --- | --- | --- |
| Unconfigured | Missing or invalid canonical target | Fail before build or remote mutation |
| Configured | Read and validate canonical target once | Capture target and write unique sibling snapshot |
| Target captured | Build | Write only this run's `.wrangler/deployments/<UUID>/dist` |
| Built | Generated target or main/assets paths disagree | Fail before migration, remove this run's output |
| Built | Generated configuration matches captured target | Migrate captured database and account |
| Migrating | Command succeeds | Publish fixed `worker/wrangler.json` from private output |
| Publishing | Wrangler succeeds | Verify captured origins through the same snapshot |
| Verifying | Public checks pass | Verified public behaviour, real login remains separate |
| Any phase | Command throws | Stop later phases |
| Run ends | Cleanup | Remove owned snapshot, remove output only if publication was never attempted |
| Publication attempted | Success or later failure | Retain artefacts for rollback or inspection |
| Failed after migration | Retry | New private run, migrations rerun idempotently |

Invariant: one run uses one captured database, account, Worker, origin set, Access audience and route/custom-domain set throughout. Generated main and asset paths remain within its output. Fixed environment naming supports hyphenated Worker names. Build validation occurs before database mutation. Another setup or build cannot replace this run's captured inputs or generated artefacts.

Standalone deployment verification and live-link verification read the canonical target, or the explicit captured `RATATOSKR_CONFIG`. Inventory and Vite's shared redirect pointer do not select their targets. Deployment neither reads nor deletes the shared pointer. Font copies stage outside public assets and use atomic replacement. A failure after publication does not trigger automatic rollback, and schema compatibility remains an operator responsibility.

### Verification requests and retries

Sources: [scripts/deployment-http.ts](../scripts/deployment-http.ts), `deploymentRequest`. [scripts/verify-deployment.ts](../scripts/verify-deployment.ts), `checkDeployment` and retry loop.

| From | Event | Next state and effect |
| --- | --- | --- |
| System-DNS request | Any HTTP response | Return response without following redirects |
| System-DNS request | `ENOTFOUND` cause | Query DNS over HTTPS |
| System-DNS request | Other failure | Propagate failure |
| DNS-over-HTTPS response | Valid IPv4 answers | Pin TLS connection to answer, retain hostname and certificate checks |
| DNS-over-HTTPS response | Invalid or missing answers | Fail |
| Pinned request | Body consumed or failure | Close dispatcher in `finally` |
| Verification attempt | Failed check with attempts left | Wait three seconds, retry |
| Verification attempt | All checks pass | Verified |
| Twelfth attempt | Failure | Stop without rollback |

Verification proves public routing and unauthenticated rejection. A Worker 401 or 403 does not prove that Cloudflare Access protected the request at the edge. Authenticated login requires a real browser session.

The attempt counter does not bound total elapsed time because fetches lack an explicit timeout. The fixed missing-link sentinel is technically claimable. Neither a production hang nor a sentinel collision was reproduced in this audit.

### Live-link fixture lifecycle

Source: [scripts/verify-live-links.ts](../scripts/verify-live-links.ts), SQL fixture setup, `expectResolution`, `expectPreviews`, and cleanup.

| From | Event | Next state and effect |
| --- | --- | --- |
| Absent | Create unique administrator and UUID slug | Active fixture |
| Active fixture | Change destination | Revised active fixture |
| Active fixture | Revoke | Revoked fixture |
| Revoked fixture | Restore | Active fixture |
| Active fixture | Delete | Tombstoned fixture |
| Any completed or failed check | `finally` cleanup | Remove only this fixture and its administrator |
| Cleanup pending | Process termination or cleanup SQL failure | Unique fixture may remain |
| Later run | New UUID | Independent fixture |

This script mutates D1 directly and is not a management authentication test. Its final removal releases a synthetic slug deliberately. That exception does not change permanent reservations in the application.

### Profiling and evidence refresh

Sources: [scripts/profile-preview.ts](../scripts/profile-preview.ts), local runtime and inspector lifecycle. [scripts/profile-preview-deployed.ts](../scripts/profile-preview-deployed.ts), traffic and telemetry. [scripts/preview-profile-report.ts](../scripts/preview-profile-report.ts), `readReport`, `checkIdentity`, and `publishReport`.

| Machine | From | Event | Next state and effect |
| --- | --- | --- | --- |
| Local profiler | Valid Linux inputs | Bundle and start runtime | Locate workerd process |
| Local profiler | Runtime ready | Cold, repeated, and varied requests | Samples and memory observations |
| Local profiler | Complete or failed run | Cleanup | Dispose Miniflare and close inspector socket in `finally` |
| Local profiler | Run complete | More runs or final write | Next run or report |
| New deployed measurement | Valid isolated staging origin | Allocate UUID and capture existing report contents | Independent run with fixed identity |
| Deployed profiler | Readiness phase | Platform misses | Up to thirty polls |
| Deployed profiler | Ready | Collect repeated, varied, HEAD, concurrent, and revisit requests | Samples with sequence numbers and UUID-bearing labels |
| Events-only refresh | Valid existing report and matching origin, Worker, and phase | Retain UUID, samples, and original measurement interval | No new traffic |
| Events-only refresh | Legacy report, missing report, or mismatched identity | Fail before querying | Existing file unchanged |
| Telemetry query | Fewer than 1,000 events | Select invocation labels for this phase and UUID | Candidate evidence |
| Telemetry query | Response reaches 1,000-event limit | Fail as possibly truncated | Existing report unchanged |
| Evidence ready | Acquire `<output>.lock` with exclusive creation | Record PID, host, UUID, and acquisition time | Own publication lock |
| Evidence ready | Existing busy or stale lock | Fail without taking ownership | Existing lock and report unchanged; a new measurement saves a recovery report |
| Refresh owns lock | Reread matching report and interval | Merge invocation records by label into latest report | Preserve samples and earlier evidence |
| New measurement owns lock | Existing contents differ from captured contents | Reject overwrite and save a unique recovery report | Newer canonical report remains |
| New measurement publication fails | Recovery write succeeds | Throw with recovery path and original cause | Samples, UUID, interval and collected invocations remain recoverable |
| New measurement publication fails | Recovery write also fails | Report both errors | Do not claim the new evidence was saved |
| Valid publication | Write private temporary file and rename | Complete replacement visible atomically | Retain run interval, update report timestamp |
| Publication ends | Success or exception | Remove owned temporary file and lock | Never remove another owner's replacement lock |

Network work runs before lock acquisition. Two refreshes can fetch evidence concurrently. A refresh contender that encounters the lock must retry. Failed new-measurement publication writes an exclusive sibling `<output>.<runId>.<UUID>.recovery.json` and reports its path. Run the profiler with the same origin, Worker and phase, `--events-only`, and `--output` set to that path to retrieve delayed events without repeating traffic. Each successful refresh rereads and merges the latest report under the lock, preventing lost evidence. Query files are private to each invocation. Unknown old reports without a UUID cannot be refreshed safely and are rejected. The 1,000-event guard reports possible truncation rather than claiming completeness. No general network deadline is promised.

### Profiling lock recovery

A killed process can leave `<output>.lock`. The publisher never steals a lock based on age. The lock records `pid`, `host`, `runId`, and `startedAt`, which identify the owner but do not prove it has stopped.

Manual recovery requires checking the recorded host and process, including command identity to avoid PID reuse. Stop or wait for the owner, and establish that no invocation is still publishing this output. Remove only that output's lock after confirming the owner is gone, then rerun the same events-only command. If the recorded host cannot be checked, retain the lock. The report remains unchanged while a stale lock blocks publication.

## Confirmed issue evidence

### SM-1: deployment target and build consistency

An interrupted setup can write configuration B and retain deployment state A. Two concurrent setups can reach the same pair with writes ordered config-A, config-B, state-B, state-A. Deployment migrates the database named in state A, then builds and publishes from configuration B. Keeping the Worker name unchanged preserves the expected output path, so path lookup does not necessarily stop publication. Concurrent deployments can also overwrite shared `dist/` between another run's build and publish.

A separate confirmed path error affects supported hyphenated Worker names. The installed Cloudflare Vite plugin's `workerNameToEnvironmentName` replaces hyphens with underscores. A Worker named `my-links` builds under `dist/my_links`, but deployment opens `dist/my-links/wrangler.json`. Publication therefore fails after migration and build. Both Astra design reviews independently identified this mismatch. A real local Vite build reproduced the underscored output directory and absent hyphenated path.

Evidence: an isolated subprocess proof executed copies of the unchanged setup and deployment scripts with a fake CLI. It injected failure only on setup's second write. Setup exited 1, migration targeted `database-a`, and build and publication selected `database-b` with the new origin. Stubbed verification let deployment exit 0. This proves target selection and ordering, not a Cloudflare deployment. The separate shared-output schedule follows the real build and publish paths.

Sources: [scripts/setup.ts](../scripts/setup.ts), final file writes. [scripts/deploy.ts](../scripts/deploy.ts), migration/build/publish sequence. [vite.config.ts](../vite.config.ts), shared output. The installed `@cloudflare/vite-plugin` defines `workerNameToEnvironmentName` in `dist/index.mjs`.

Regression target: interrupted writes, stale state, and concurrent runs cannot change a run's captured deployment target or replace its artefacts. Publication locates the actual generated configuration for default and hyphenated Worker names. Invalid input fails before remote mutation. Command failures stop later phases and clean only that run's temporary files.

### SM-2: Access application reuse

An existing app can keep the expected name and primary `/admin` domain while losing protection for `/api` and `/assets`. Setup ignores the full domain set. It also accepts an allow policy that excludes the intended administrator or requires an unrelated group because it does not compare `exclude` or `require`.

Evidence: the isolated fake-CLI proof supplied an app protecting only `new.example.com/admin`, excluding the expected email, and requiring an unrelated group. Real setup code exited 0 and reported Access and D1 ready. This demonstrates incomplete validation. The Worker still verifies JWTs, so the finding is not an authentication bypass.

Source: [scripts/setup.ts](../scripts/setup.ts), Access response schema and reuse checks.

Regression target: validate effective management coverage, application type, allow decision, exact include rules, restricted identity provider, and empty exclusions and requirements. Current `destinations[].uri`, legacy `self_hosted_domains`, and singleton `domain` representations need explicit handling. Conflicting or incomplete representations fail without changing unrelated resources. Created responses require the same checks as reused responses.

### SM-3: preview binary integrity

An authenticated upload can supply `{compressed:"AAAAAAAA",checksum:0}`. The wire schema accepts the shape. The Worker stores it and returns image success even though the PNG cannot be decoded. The same input is accepted for a custom header and can break every generated image.

Evidence: a real Workers/D1 reproduction returned 201 for creation, 204 for invalid body upload, 200 for GET and HEAD, and a PNG inflate error. The invalid custom-header PATCH returned 200. A direct assembly reproduction reported `invalid stored block lengths`. A separate runtime check confirmed that bounded `inflateRawSync` supports output limits and consumed-byte reporting in this repository's Workers runtime.

Sources: [shared/preview-image.ts](../shared/preview-image.ts), `previewSegmentSchema`. [src/preview-image.ts](../src/preview-image.ts), `storePreviewImage`. [src/settings.ts](../src/settings.ts), `updateSiteSettings`. [src/png.ts](../src/png.ts), `assemblePreviewPng`.

Regression target: reject undecodable, truncated, prematurely finalised, trailing-data, wrong-size, wrong-filter, wrong-checksum, and excessive-output sections before any write. Valid shared-compressor output remains decodable after public PNG assembly. Rejected branding preserves the previous name, header, and audit history.

Rejecting future writes does not repair already corrupted rows. Affected bodies require regeneration. A valid settings save replaces a bad header. This audit has not scanned or changed production data.

### SM-4: mutation retries and audit semantics

Three related traces expose command outcomes that the UI or audit records incorrectly.

| Trace | Observed outcome | Intended outcome |
| --- | --- | --- |
| Generated create commits, response is lost, unchanged form is retried | Another live slug and another create audit | Retry acknowledges the same logical creation |
| Delete commits, response is lost, confirmation is retried | 404, error remains | A known tombstone acknowledges completed deletion without another audit |
| Active row receives `{title:"After",status:"active"}` | Audit says `restore` although status never changed | Audit says `update` |

Evidence: real D1 scratch tests submitted identical generated POSTs and counted two active rows and two create audits. Another observed DELETE responses 204 then 404. A mixed PATCH produced audit actions `create, restore` without any revocation. The UI's preserved draft and retry behaviour provides the lost-response schedule. Two independent unkeyed POSTs remain valid API operations. The defect is treating retry of one UI command as a new command.

Sources: [src/links.ts](../src/links.ts), `createLink`, `deleteLink`, and action selection in `updateLink`. [admin/api.ts](../admin/api.ts), `createLink`. [admin/main.tsx](../admin/main.tsx), create submission and confirmation handling.

Regression target: a stable actor-scoped creation identity deduplicates simultaneous requests and ambiguous retries atomically with the slug and audit. Identity reuse with changed input rejects. Replay after expiry is recognised, and replay after deletion never resurrects the link. Tombstone deletion retries produce one delete audit. Audit labels follow actual old/new status, including mixed patches and no-ops.

### SM-5: independent settings edits

Editor A opens default settings. Editor B saves a custom display name. A changes only the home redirect but submits its stale default name too. The server assigns both fields, reverting B's name and header. The reverse sequence can erase another administrator's home redirect.

Evidence: a real D1 route reproduction saved `Fresh branding`, then submitted a stale default name with a new home redirect. Both requests returned 200. The stored name became `Ratatoskr` and the header became null. This is an unintended unchanged-field overwrite, rather than two deliberate edits to the same field.

Sources: [admin/main.tsx](../admin/main.tsx), `SettingsDialogContent`. [admin/api.ts](../admin/api.ts), `saveSiteSettings`. [src/settings.ts](../src/settings.ts), `updateSiteSettings`.

Regression target: changed-field settings patches preserve independent edits in either order and under concurrency. Display name and header stay atomic. Home-only edits do not require a header. Null clears the URL. No-op retries do not create audits. The existing settings test helper must also include the required home URL when validating its name fixture, so it renders the intended name instead of always rendering `invalid`.

### SM-6: UI request ownership, pending drafts, and expiry

| Failure | Reachable schedule and evidence | Impact |
| --- | --- | --- |
| Abort becomes ordinary API error | Real native fetch receives partial JSON, then aborts. Real `readJson` swallows the body error and reports `ApiError`, with `isAbortError=false` | Obsolete request can publish a visible failure |
| Old read overwrites a mutation | First list read starts, create succeeds while loading, old read then completes. Current creation handler skips loading state | Newly created link is missing until refresh |
| Old page belongs to new query | Query changes while page response remains pending. Callback checks only ready state | Rows or cursor can belong to the previous query |
| Edited row no longer matches search | Search for a unique title, change that title, save. Replacement checks only status | Visible results violate search |
| Visible draft changes during save | Submit A, type B while POST or PATCH is delayed, then receive success for A | B is discarded when dialog closes or shows success |
| Expiry passes without render | Leave active row visible across its expiry with no interaction | Active badge remains after backend returns 410 |

The abort case was executed against a real streamed loopback HTTP response using the actual API module. The remaining cases have source schedules with no missing application guard. The implemented regression cases and execution results are recorded below.

Sources: [admin/api.ts](../admin/api.ts), `readJson` and unsuccessful-body handling. [admin/main.tsx](../admin/main.tsx), `App`, `Workspace`, list effects, mutation handlers, create/edit fields, `StatusBadge`, and `ExpiryText`.

Regression target: only current session/query/cursor owners publish success, failure, or completion. Mutations invalidate older reads synchronously and refresh the current query. Aborts retain cancellation identity through body parsing. Pending create/edit fields and dismissal controls stay disabled, then recover on failure. A shared clock updates expiry at its deadline and after visibility or focus restoration without changing persisted status semantics.

### SM-7: telemetry refresh

The documented `--events-only` path skips traffic collection, leaves `samples` empty, and overwrites the output file. An empty telemetry response also replaces previously collected invocations. A later retry can query a fresh last-hour interval that excludes the original measurements.

Evidence: an isolated subprocess proof ran the real script against a saved report containing one sample and one invocation, with an empty telemetry CLI response. The script exited 0. Both saved counts changed from one to zero. No Cloudflare request or production traffic was used.

Source: [scripts/profile-preview-deployed.ts](../scripts/profile-preview-deployed.ts), events-only branch, telemetry query, and report write.

Regression target: validate report identity, retain client samples and original measurement interval, merge invocations by request label, and write atomically. Empty or delayed refreshes preserve existing evidence. Wrong phase, origin, or Worker rejects without altering the report.

## Evidence and verification record

| Check | Result | What it proves |
| --- | --- | --- |
| Baseline `bun run verify` | 168 tests, type checks, and build passed | Existing checks passed before fixes |
| Baseline storage subset | 101 tests passed | Existing D1 transaction, lifecycle, settings, and generator coverage |
| Temporary baseline storage reproduction | Four assertions passed against real Workers/D1 | Duplicate unkeyed creation, stale settings overwrite, delete retry 404, and wrong audit label reproduced |
| Temporary baseline routing reproduction | Invalid upload and bounded-inflate assertions passed | Malformed image acceptance reproduced, validation primitives available |
| Baseline native streamed-body abort reproduction | `ApiError`, `isAbortError=false` after abort | Cancellation identity was lost in the original API helper |
| Baseline isolated script fixtures | Failure traces reproduced with fake CLI responses | Original target selection, Access omissions, and report overwrite reproduced |
| Integrated Workers run | 181 tests passed | Current Worker regressions pass in real local D1 |
| Node regression suite | 26 tests passed | Filesystem concurrency, fake-CLI commands, a real Vite build and body cancellation checked |
| Browser regression suite | 17 cases passed in final full verification | Real local D1 flows, desktop/mobile layouts, appearance, delayed responses, pending forms, retries and expiry checked |
| `bun install --frozen-lockfile`; `bun run verify` | Passed | Type checks, all test suites and production build passed after the review follow-up changes |
| Independent final Opus review | No blockers; four low-severity findings resolved | Opus independently reran Workers and Node tests; Astra reviewed and verified the follow-up fixes |
| Live publication and `bun run verify:deployment` | Passed | Existing Worker published; public routing and unauthenticated Access protection checked |
| `bun run verify:live-links` | Passed, fixture removed | Live redirect, preview, edit, revoke, restore and delete behaviour exercised through a unique direct-D1 fixture |
| Original production data | Three link rows and existing settings/branding/audits unchanged | Before/after database snapshots compared; three redirects, six previews and three decoded PNGs passed |
| Authenticated production browser flow | Not completed: browser automation unavailable | No claim that the account's Access login or authenticated management mutations were tested live |

Scratch reproductions were audit artefacts under `/tmp`. The original inputs and outcomes remain above. Permanent regressions are linked below. Workers/D1 tests retain `fsModuleCache: false`. Node filesystem/subprocess tests use `bun run test:node`. Playwright drives a local Vite/Worker application with isolated local D1 through `bun run test:admin`. Its server applies migrations with an explicit generated local configuration. Neither fake CLI responses nor local-mode browser checks prove the live Access login flow.

## Design and implementation record

GPT-6 Astra completed four subsystem audits and two independent design candidates before implementation. Claude Opus 5.5 confirmed the findings and reviewed both designs with fast mode disabled. The selected design keeps the existing module boundaries. It adds durable creation identity, partial settings updates, request ownership, write-time binary validation, and immutable deployment inputs. The second candidate contributed build-and-validate before migrations and separation of URL normalisation from current configuration checks.

Mandatory revisions on every record and a general command framework were rejected. They would change intentional same-field last-write-wins behaviour and add conflict handling without addressing another confirmed bug. A global deployment lock was rejected because private artefacts remove the shared file race. A short lock remains necessary when publishing one shared profiling report.

The selected implementation is:

- Creation accepts an optional UUID `requestId`. The first-party browser retains the typed command and UUID for an unchanged displayed draft, including after expiry. One D1 transaction conditionally inserts the link, audit, and actor-scoped receipt, then selects the receipt. Replay returns HTTP 201 with the current `Link`; changed payload returns 409. Deleted replay returns 409 before hash comparison. Migration 0005 makes the payload hash nullable and clears it on tombstoning, so deletion leaves no destination fingerprint. Unkeyed calls and abandoned browser forms remain distinct commands.
- Update audit insertion selects the old row and names its actual transition. The immediately following UPDATE is gated by `changes()`, keeping one actual-change predicate. Both statements roll back together. Repeated deletion of a known tombstone succeeds without a second audit; a never-used slug remains 404.
- Settings accepts a non-empty partial patch. Omitted values remain omitted. Name and header change together; home-only edits never compare or replace branding. A supplied default name ignores an otherwise schema-valid header and restores the bundled header, preserving the previous API behaviour. Update, resulting-row audit, and conditional branding statements stay adjacent.
- `src/preview-segment.ts` owns `validatePreviewSegment(segment, section)`. It checks bounded inflation, exact consumed and decoded bytes, filter-zero scanlines, checksum, and sync-flush termination. It and PNG assembly share the terminal DEFLATE block. Every malformed-data or zlib error becomes 400 before any write. Public reads do no decompression.
- A focused admin list owner invalidates first-page and continuation requests synchronously. Ready state belongs to a generation, so its old cursor cannot be used after invalidation. Only current success, error, expiry, and completion handlers may publish. Mutations refresh the current query and return to its first page. Session loading has its own owner. Pending form fields are disabled. One clock refreshes visible expiry labels.
- `wrangler.deploy.json` is the sole deployment-target authority. Setup replaces it atomically. Each deploy captures a sibling configuration snapshot, builds into a private directory with the fixed Vite environment `worker`, validates the generated target, semantic routes/custom domains and contained main/assets paths, then migrates, publishes, and verifies that snapshot. Successful or possibly published artefacts remain available for rollback. Standalone verification scripts read the canonical configuration. Font copies use atomic replacement. Scripts never select a deployment through Vite's shared redirect pointer.
- Access reuse validates complete effective destinations and policy, including public destinations on other applications regardless of type. Other apps may have private destinations, which are ignored by overlap checks; the owned app retains strict public-only validation. Non-domain application summaries remain parseable. Hostname case and documented root forms are normalised. Non-root wildcard suffixes and path case are not silently treated as equivalent: Cloudflare explicitly says `example.com/alpha/*` excludes `example.com/alpha`. Unknown or conflicting coverage requires review without modifying unrelated resources. See [Cloudflare application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).
- New profiling reports and request labels contain a run UUID and original measurement interval. Refresh rejects legacy ambiguous reports, preserves samples, and merges only that run's invocations. A response reaching the telemetry result cap is reported as possibly truncated. After network work, an exclusive output lock protects reread, identity validation, merge, and atomic replacement. Busy or stale locks fail safely; they are never stolen by age. Query files are private to each invocation.

Five GPT-6.1-Terra implementation workers used disjoint ownership: backend contracts and D1 commands; preview validation and images; operations and deployment; profiling reports; and admin UI with test/package integration. The backend imports the preview validator's agreed signature. The admin worker alone changes package and test configuration. Astra owns this document and verification/review decisions.

| Issue | Implemented design | Regression coverage | Status |
| --- | --- | --- | --- |
| SM-1 | Captured canonical target, private output, build validation before migration | `tests-node/operations-deploy.test.ts` | Implemented and locally verified |
| SM-2 | Exact Access destinations and policy, overlapping-application rejection | `tests-node/operations.test.ts` | Implemented and locally verified |
| SM-3 | Bounded semantic validation before storage | `tests/preview-validation.test.ts` | Included in 181 passing Workers tests |
| SM-4 | Atomic receipts, hash erasure, tombstone acknowledgement, actual-transition audit | `tests/links.test.ts`, browser creation retry | Worker and elapsed-expiry browser retry regressions passed |
| SM-5 | Changed-field PATCH and atomic resulting-state audit | `tests/settings.test.ts`, browser settings flow | Worker and two-session browser regressions passed |
| SM-6 | Owned requests, disabled pending fields, shared expiry clock | `tests-node/admin-api.test.ts`, `tests-browser/admin.test.ts` | Node and browser regressions passed |
| SM-7 | Run UUID, original interval, locked atomic evidence merge | `tests-node/profiling.test.ts` | Implemented and locally verified |

### Permanent regression cases

These names identify the permanent tests exercised by the verification runs above.

| Issue | File | Regression names |
| --- | --- | --- |
| SM-1 | [operations-deploy.test.ts](../tests-node/operations-deploy.test.ts) | `captured target survives replacement and stale inventory`; `failed stages stop later operations and retain only possibly published output`; `simultaneous deployments own separate outputs and snapshots`; `real Vite build supports hyphenated names with contained paths`; `an interrupted atomic replacement leaves the previous target readable`; `standalone verification and live fixture select canonical target instead of inventory`; `invalid deployment origins fail before build or mutation`; `generated variable key order does not change the target`; `malformed shared Vite pointer cannot interrupt owned cleanup`; `font staging occurs outside the public assets directory` |
| SM-2 | [operations.test.ts](../tests-node/operations.test.ts) | `Access requires all destinations and an exact policy`; `overlapping applications fail while unrelated non-domain applications remain valid`; `modern and legacy destinations reject private, inconsistent and insufficient coverage`; `overlap detection keeps path case and considers broader and more specific paths`; `empty representations are ignored and partial wildcards overlap conservatively`; `literal path siblings do not overlap management paths` |
| SM-3 | [preview-validation.test.ts](../tests/preview-validation.test.ts) | `accepts compressor sections and decodes the complete assembled PNG`; `rejects malformed sections without changing images, branding or audits` |
| SM-4 | [links.test.ts](../tests/links.test.ts) | `replays concurrent keyed creations and clears the receipt hash on deletion`; `replays expired creations and scopes keys to each administrator`; `retries generated collisions and leaves no receipt for a custom collision`; `returns HTTP 201 with the current link when a creation is replayed`; `allows simultaneous deletion retries with one delete audit`; `rolls back keyed creation when the create audit fails`; `rolls back a keyed creation when its receipt fails`; `audits mixed updates from the actual previous status and rolls back failed mutations` |
| SM-5 | [settings.test.ts](../tests/settings.test.ts) | `preserves independent partial changes and audits the resulting settings`; `preserves the redirect and branding independently and ignores a default-name header`; `rolls back settings and audit when branding fails and leaves no-op changes unaudited` |
| SM-6 | [admin-api.test.ts](../tests-node/admin-api.test.ts) | `aborting a response body preserves AbortError for success and failure` |
| SM-4, SM-5, SM-6 | [admin.test.ts](../tests-browser/admin.test.ts) | `local create and appearance survive reload at desktop and mobile widths`; `creation retries the same command after a dropped response`; `appearance persists after reload`; `local edits, revocation, restoration, preview and settings`; `pending creation freezes the form and permits retry after failure`; `visible links expire without interaction`; `superseded search ignores stale 200 responses`; `superseded search ignores stale 500 responses`; `superseded search ignores stale 401 responses`; `a delayed page renders already expired links correctly`; `independent settings edits preserve fields from another session`; `mutation invalidation removes the old pagination cursor before reload`; `creation during initial load refreshes the list`; `editing a searched title removes it from the current result`; `pending edit freezes inputs, clear and dismissal until failure`; `a mutation completing after a query change refreshes the current search` |
| SM-7 | [profiling.test.ts](../tests-node/profiling.test.ts) | `refresh preserves evidence, uses the original window, and filters other runs`; `locks prevent contention and stale lock takeover; failed publication cleans its lock`; `simultaneous refreshes retain both independently fetched event sets`; `new measurement rejects a changed report and publication errors release the lock`; `legacy and mismatched identities fail before querying` |

The preview rejection case exercises invalid compressed bytes, wrong checksums, row counts, non-zero filters, truncated flushes, premature final blocks, trailing data, excessive output, and invalid base64. Each malformed case uses separate correctly sized header and body fixtures. Script fixtures prove command selection and ordering without contacting Cloudflare. The hyphenated-name case also runs the real Vite build. Browser cases use the actual local application, with selected request interception to control failures and clocks. The creation-retry case drops the response after a real commit, advances the browser clock past expiry, and checks reuse of the same UUID. A fresh form with that expired value is rejected. Search cases deliver obsolete success, server error, and authentication error responses. The pagination case checks that an acknowledged mutation removes the old cursor before reload. Pending creation and edit fields, expiry clearing and dismissal are exercised directly. The independent review and its completed follow-up fixes are recorded below.

## Independent review and follow-up

Claude Opus 5.5 reviewed both the design and the completed implementation with fast mode disabled. The final review found no blockers, confirmed all seven issue groups and eight design amendments, and independently reran 181 Workers/D1 tests and the then-current 22 Node tests. It did not rerun the browser suite or verify production. Astra assessed the findings and specified these follow-up changes; the existing Terra owners implemented them. Astra reviewed their source and reran full verification. The follow-up changes were not sent through another Opus review.

| Review finding | Reproduced schedule and impact | Resolution and permanent evidence |
| --- | --- | --- |
| F1, low, SM-2 | An unrelated Access app mixes public and private destinations; scanning it throws and prevents setup | Other-app scanning projects only public destinations; strict own-app validation is retained. `other applications project public destinations across types` covers unrelated and overlapping mixed apps |
| F2, low, SM-2 | A domain-bearing SSH or RDP app is skipped solely because of its type; local overlap validation incorrectly accepts it | Inspect public destinations across every application type. The same regression rejects overlapping SSH/RDP fixtures and permits domainless apps |
| F3, low, SM-7 | A measured run reaches publication after another writer acquires the lock or replaces the report; its samples and UUID would be lost | Save a unique recoverable sibling on failed new-report publication, preserving the canonical file and foreign lock. Tests cover busy and changed reports, events-only recovery, and failure to save recovery |
| F4, low, SM-6 | A visible revoked row crosses expiry without another render; expiry text stays stale though its Revoked badge is correct | Schedule the shared clock for all expiring rows. `revoked links update their expiry text at the deadline` checks the label and unchanged badge |

F2 proves a local validation omission, not a live Access precedence rule or authentication bypass. Cloudflare documents browser-rendered terminals on public application hostnames; the conservative scan checks all exposed public domains. Live overlapping SSH/RDP precedence was not exercised. See [Cloudflare browser-rendered terminals](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/browser-rendering/).

Two non-blocking coverage gaps were also closed: generated deployment routes/custom domains are compared with the captured target before migration, ignoring object key order; and malformed preview headers use header-sized fixtures. Their cases are `generated routes match captured custom domains semantically` and `rejects malformed sections without changing images, branding or audits`. Recovery cases include `a busy new measurement is recoverable and can refresh events` and `a failed recovery reports both errors`.

A PATCH that changes status and other fields intentionally records one revoke or restore action. If status is unchanged, its audit action is update. Pre-existing malformed preview data is not automatically repaired, and a browser reload or abandoned creation form starts a new command.

## Production publication record

On 9 November 2026, the existing `ratatoskr` Worker was redeployed from commit `775e01e` using `bun run deploy`. The active version is `4e092118-1c19-42c4-8fcf-fe3ee05231db`, serving the existing `v4ri.link`, `admin.v4ri.link` and `preview.v4ri.link` custom domains. Only outstanding migration `0005_creation_requests.sql` was applied; migrations 0001–0004 were already present. No setup or resource replacement was run.

The source was pushed to `origin/main` in logical units:

| Commit | Unit |
| --- | --- |
| `c1c433e` | Preserve the existing home-page redirect feature |
| `307139d` | Retry-safe storage mutations, settings patches and preview validation |
| `6879f48` | Deployment target isolation and Access validation |
| `c0d0122` | Profiling identity, concurrent refresh and recovery |
| `ad5b716` | Admin request ownership, pending forms and browser regressions |
| `775e01e` | State-machine reference and verification documentation |

Before publication, `cf` captured live deployment metadata, Access configuration and database rows. A private 50,966-byte SQL backup was saved locally at `.git/state-machine-audit/redeployment/backup-before.sql`; it is not tracked. Wrangler's separate cached authentication initially failed, so its backup and deployment processes used the already-authenticated `cf` OAuth credential through a process-only environment variable. The CLI maintained its own authentication cache. No credentials were printed or committed, and both application deployment configuration files remained unchanged.

After publication, exact comparisons confirmed unchanged Worker variables, database and rate-limit bindings, asset routing, compatibility settings, Access application/policies, local deployment configuration, all three original links, site settings, branding, preview bodies and existing audit records. `bun run verify:deployment` and `bun run verify:live-links` passed. The latter removed its uniquely named fixture; no verification links or administrators remain. Each original link also passed its redirect check, both preview routes and PNG decompression. These checks finished at 13:19 UTC.

The authenticated browser check could not run: the browser access host was unavailable, and native browser access timed out or returned `cgWindowNotFound`. A human Access login and authenticated create/edit/revoke/delete flow remain a separate verification step. Direct-D1 fixture checks do not substitute for that login. Issues 3–9 are closed with their implementation commits, deployment version, verification results and this remaining limitation recorded.

## Non-findings and concurrency limits

- Database constraints prevent destination-bearing tombstones. Atomic claims and audits passed existing concurrency and rollback tests.
- Link edit already submits changed fields. Ordinary same-field last-write-wins is not reported as a bug.
- Expiry and revocation are separate dimensions. Restoring an expired link does not imply extending its life.
- Primary reads govern new availability lookups. A response already based on an earlier read can finish after a mutation. Delivered redirects and externally cached images cannot be recalled.
- Keyset pagination does not promise a snapshot across requests. Client query ownership must still prevent mixing unrelated pages.
- A representable combination of dialog booleans, or missing synchronous double-click lock alone, does not prove a reachable UI failure.
- Missing singleton rows, manually corrupted settings, DNS rebinding, ignored abort signals in artificial mocks, and bundled Wasm initialisation failure were not established as reachable production bugs here.
- Setup retries may encounter remote resources created by an earlier partial run. They must validate ownership and policy. This audit did not prove that concurrent setup silently replaces unrelated resources.
- Verification retry counts do not establish a total deadline. Public rejection checks do not establish authenticated access or edge Access coverage.
- The current public image implementation assembles stored sections. Older README descriptions of a server render cache are not evidence that such a cache exists.
