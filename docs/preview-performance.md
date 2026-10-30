# Preview image performance

The admin device now renders link images. Workers store the compressed pixels in D1 and assemble a 600 × 315 PNG from a link body and a shared branding section. Public image requests do not load fonts, instantiate Wasm, rasterise, deflate or write to the database. There is no isolate image cache.

One `first-primary` D1 query reads the link's availability, its matching body and the branding section in the same snapshot. Title/destination edits delete the previous body in the link transaction. A delayed upload cannot replace an edited or deleted link's image. Expiry, revocation and deletion take effect on the next lookup. Missing bodies return an uncached 503 with `Retry-After`; no previous image is substituted. HEAD checks the same snapshot without assembling bytes.

Creation has two steps because generated slugs are allocated by the server. The browser receives the saved link, renders its body and uploads it to the authenticated API. An interrupted browser or upload leaves redirects working and images unavailable. **Regenerate preview image** retries generation, including for pre-migration links. External API clients must perform the upload too. Link and audit transactions remain atomic; a failed edit rolls back image invalidation with the edit.

The browser uses self-hosted Inter and resvg/Wasm. Rendering and compression therefore use the administrator device's CPU, not another Worker invocation, `waitUntil`, a queue or a paid service. The PNG sections contain independently sync-flushed raw DEFLATE blocks. The Worker joins them, combines Adler-32 checksums and writes PNG chunks without inflating pixels. Round-trip tests verify decoded pixels and checksums. Uploads are limited to 128 KiB, with at most 96 KiB of base64 per section; the server validates the bounded wire format, not the visual content of an authenticated administrator's image.

## Plan and accounting, checked 30 October 2026

This account is on Workers Free. A staging upload with `limits.cpu_ms = 10` was rejected with Cloudflare error `100328`, explicitly stating that configurable CPU limits are unavailable on Free. The account-settings value `standard` is a usage model, not evidence of a paid subscription. No billing plan was changed.

The current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) specify 10 ms CPU per Free HTTP request, 128 MB isolate memory, a 64 MiB uncompressed Worker limit and a one-second startup limit. Network and database waiting do not count as CPU. Cloudflare permits some infrequent CPU overruns, so a 200 response does not demonstrate compliance with the 10 ms allowance.

The existing D1 service remains the only storage dependency. [D1 Free limits](https://developers.cloudflare.com/d1/platform/limits/) include 500 MB per database, 5 GB per account and 2 MB per row. Its [daily allowances](https://developers.cloudflare.com/d1/platform/pricing/) are five million rows read and 100,000 written. Compressed bodies consume storage and each image reads indexed primary records. There are no per-click writes or automatic backfill jobs. Capacity exhaustion causes failures; it does not enable billing or silently serve an old image.

## Deployed staging method

All deployments used uniquely named `ratatoskr-preview-cpu-20261030*` Workers on `workers.dev`, one isolated APAC D1 database and synthetic example.com destinations. Production code, data, routes, domains, Access applications and billing were not changed. Staging management paths denied unauthenticated access. No real Access login was exercised in staging. After measurement, all 19 temporary Workers and the isolated database were deleted. Follow-up account listings confirmed that no staging resources remained and unrelated Worker IDs/deployment timestamps were unchanged.

CPU values below come from Workers Observability invocation `$workers.cpuTimeMs`, queried with the existing `cf` login. They include application routing, configuration, primary-D1 protocol handling and response generation. `$workers.wallTimeMs` is retained separately in the evidence. Client latency was never substituted for CPU. Values are reported in integer milliseconds. Logs arrived late and were fetched again after traffic ended.

Final runs added a staging-only wrapper with isolate IDs and monotonically increasing request counters. The first successful request had sequence 1 in a new isolate. Two separate Workers exercised fresh startup. Each run used one first image, 29 varied images, ten HEAD requests and eight concurrent requests. The fixtures exceed the former eight-entry cache. Explicit eviction cannot be forced; independent Workers provide fresh-isolate evidence without touching production. Brief platform 404s during new hostname propagation had no wrapper headers and are excluded from invocation CPU statistics.

Use the repeatable collector against prepared staging fixtures `sample-0` through `sample-44`:

```sh
bun run profile:preview:deployed \
  --origin https://STAGING_WORKER.ACCOUNT.workers.dev \
  --worker STAGING_WORKER --phase stored \
  --output verification-artifacts/deployed-preview.json
```

Worker names must start with `ratatoskr-preview-cpu-`. Rerun with `--events-only` after ingestion to fetch CPU records without more traffic. The command bounds traffic, records failures and optional isolate headers, and refuses non-staging hostnames. Deployment configuration and resource IDs remain ignored. Deploy immutable copies of the built runtime/assets when switching branches; apply migrations with that staging configuration, seed only synthetic data, and delete the exact staging Workers/database afterwards.

## Shared deployed results

The original #1 remote head was `dcd215abc843ecbdd085bd548322916a91dd0baf`. Its invocation CPU was substantially higher than the earlier local profiler suggested:

| Original request-time renderer | n | Median CPU | p95 CPU | Maximum CPU |
| --- | ---: | ---: | ---: | ---: |
| First PNG | 1 | 152 ms | 152 ms | 152 ms |
| Warm uncached titles | 30 | 21 ms | 32 ms | 36 ms |
| Cached PNG | 20 | 2 ms | 3 ms | 4 ms |
| HEAD | 10 | 2 ms | 2 ms | 2 ms |
| Eight concurrent images | 8 | 125 ms | 219 ms | 219 ms |
| Revisit after cache churn | 1 | 13 ms | 13 ms | 13 ms |

All 70 requests returned 200. That establishes over-budget CPU paths on Free, not a confirmed resource-limit termination. Concurrent CPU is the platform's per-invocation report; overlapping invocations make it unsuitable for estimating isolated renderer cost.

The final stored-image implementation also prepares fixed routing and PNG headers during startup. It validates real deployment bindings at startup and still validates the current bindings on every request. It does not cache authentication, configuration derivatives, availability or redirects.

| Stored images, two fresh Workers | n | Median CPU | p95 CPU | Maximum CPU |
| --- | ---: | ---: | ---: | ---: |
| First PNG | 2 | 5–6 ms | 5–6 ms | 6 ms |
| Varied images | 58 | 1 ms | 2–3 ms per run | 4 ms |
| HEAD | 20 | 1 ms | 1 ms | 1 ms |
| Concurrent images | 16 | 1 ms | 3–5 ms per run | 5 ms |

The first version's API-reported `startup_time_ms` was 17 ms, below the one-second startup limit. The Worker upload fell from 3,578.55 KiB / 1,451.43 KiB gzip to approximately 290 KiB / 73 KiB gzip. Wasm and font binaries are now admin assets rather than Worker modules.

A supplementary 70-request run exercised repeated/varied images and the collector itself. All 70 CPU records were retrieved, with a maximum of 6 ms; those records are included in the evidence.

**All received CPU records for the shared stored-image path stayed within 10 ms, including two confirmed fresh isolates.** This finite SIN-colo sample does not establish a universal tail guarantee. The stacked display-name PR has additional measurements and remaining over-budget cases; do not infer its compatibility from this table.

No `exceededCpu` or `exceededMemory` invocation outcome was observed in the valid baseline/final samples. Production per-isolate heap/RSS was not exposed by this measurement. Removing Worker font/Wasm/pixel allocations and bounding compressed sections provide resource bounds, not a direct production memory measurement. Startup and package sizes likewise do not prove memory compliance.

Sanitised invocation records, including wall time, outcomes and version IDs, are in [preview-deployed-results.json](preview-deployed-results.json). Setup failures, mixed-version rollout traffic and intermediate implementations are excluded from the final table.

## Historical local results, 24 October 2026

These Linux workerd main-thread CPU measurements exclude the application router, D1 and background compiler threads. They are not deployed CPU accounting. `bun run profile:preview` retains the legacy rendering/native-encoder primitive for comparison. It is neither the current public path nor an end-to-end browser benchmark. It requires Linux `/proc/PID/task/PID/schedstat` and cannot run on the current macOS host.

The original 1200 × 630 renderer had warm medians of 26.0–26.8 ms and first-render CPU of 74.4–94.9 ms. The 600 × 315 renderer with native level-1 deflate measured 41.2–44.4 ms on first render, warm changed-title medians of 5.4–5.6 ms, p95 of 7.2–9.4 ms and a maximum of 10.4 ms. Cached-image medians were 0.21–0.23 ms. A typical PNG was approximately 13 KiB.

Observed Wasm linear memory was 3.34 MB, V8 used heap 1.6 MB and backing storage 6.3–7.8 MB. Those fields are not additive production memory evidence. The former isolate cache was capped at eight images / 512 KiB. It reduced repeats but could not resolve first-render or eviction costs, which is why persistence replaced it.

## Display-name staging results

The stacked PR preserves accepted names, shaping, bidi ordering and glyph-advance layout. The browser loads only the Arabic/CJK subset pages needed by the SVG, from the same authenticated, self-hosted admin assets as Inter and Wasm. The inventory bounds its font cache. Failed font loads are removed from the cache so saving can retry. No font binaries or text-layout tables enter the public Worker.

A custom-name save supplies its rendered header with the name. D1 commits the name, header and audit together. Default-name saves restore the built-in header. Link bodies do not need regeneration when the name changes, so the operation has constant database work regardless of link count. An external settings client must supply `previewHeader` for a custom name; missing headers are rejected before changing settings. Migration `0003_site_settings.sql` follows #1's `0002_preview_images.sql`.

The original #2 remote head was `baa3d039c81f852db8ccea19e7d1136f8c07c0b2`. Its dedicated deployed baseline used 12 requests per name. Three early Chinese requests returned 404 without an invocation record during hostname propagation and are excluded. The remaining 57 requests returned 200:

| Original renderer, requests by name | CPU records | Median CPU | p95 / maximum CPU |
| --- | ---: | ---: | ---: |
| 我的链接 | 9 | 146 ms | 253 ms |
| روابطي | 12 | 23 ms | 34 ms |
| Mixed Chinese/Arabic/numbers | 12 | 26 ms | 32 ms |
| Diacritics | 12 | 19 ms | 36 ms |
| 48 ideographs from distinct font pages | 12 | 43 ms | 60 ms |

These baseline requests were not instrumented with isolate counters, so repeated URLs cannot reliably be classified as cache hits. The first Chinese request has no invocation CPU record. The #1 baseline and the final runs provide separately identified first-request measurements.

The final implementation used two independently deployed Workers, each with a confirmed sequence-1 request in a new isolate, the 48-page branding header, 29 varied bodies, ten HEADs and eight concurrent GETs:

| Stored image path | n | Median CPU | p95 CPU per run | Maximum CPU |
| --- | ---: | ---: | ---: | ---: |
| First PNG | 2 | 14–18 ms | 14–18 ms | 18 ms |
| Varied images | 58 | 3 ms | 8 ms | 16 ms |
| HEAD | 20 | 1–2 ms | 2–3 ms | 3 ms |
| Concurrent images | 16 | 3–4 ms | 3–12 ms | 12 ms |

All 96 returned 200 with invocation outcome `ok`. CPU above 10 ms was observed on both first requests, one varied-image request and two concurrent requests. This is not a claim that those requests were terminated. It also does not demonstrate reliable Free compatibility.

A separate secret-protected diagnostic measured persistence against synthetic D1 records. It was never the application entry point and was deleted afterwards. It exercised the real upload schema/storage function and settings/audit transaction, but excluded Access JWT validation and the application's streaming body parser. Public image GETs still used the complete application. Eighteen settings writes across six real rendered names took at most 11 ms, on the first write; fifteen body uploads took at most 4 ms. All succeeded. Thus moving rendering into the browser did not put rasterisation into another constrained Worker operation, but the complete authenticated write flow is not proven within 10 ms.

Five adversarial 120-character titles were rendered by the actual browser generator: Chinese, Arabic, mixed scripts/numbers, diacritics and long Latin text. Their uploaded base64 bodies were 16,304–23,652 bytes. Each was fetched eight times with the 48-page branding header. Maximum invocation CPU was 12 ms for Chinese, 3 ms for Arabic, 2 ms for mixed scripts, 9 ms for diacritics and 2 ms for long Latin text. The 12 ms sample was the diagnostic Worker's first public application GET. Every request returned 200; the actual resulting PNGs were inspected.

**Reliable Free compatibility for #2 remains uncertain. Strict 10 ms compliance is disproven for the observed cold, varied-image, concurrent and first-settings-write cases.** Rendering is now entirely on the admin device, and public CPU is much lower, but the remaining routing, D1 protocol, JSON/base64 and PNG packaging path still has over-budget samples. This run did not attribute the residual CPU to individual runtime operations. Averages and successful responses do not resolve those tails. No paid plan or paid rendering service was introduced as a workaround.

The Worker upload fell from 14,288.74 KiB / 7,844.62 KiB gzip to 294.78 KiB / 73.96 KiB gzip. API-reported startup was 39 ms and 25 ms in the two final Workers. The 10,842,968 bytes of Arabic/CJK fonts are now browser assets; ordinary saves load only required pages. This shifts rendering memory/CPU to the admin device, not a Cloudflare background task. No production isolate-memory metric was available, and package size alone is not memory proof.

Local Chromium checks covered desktop/mobile settings, save/reload, reset, appearance persistence, a failed settings-write retry and a failed font-download retry. Actual PNGs were inspected for Chinese, Arabic, Arabic marks, mixed scripts/numbers, diacritics and 48 distinct CJK pages. The local application used explicit `wrangler.jsonc` migrations. Live synthetic public requests additionally verified 200 before revocation, 410 after revocation/expiry, 503 after an edit pending upload and 404 after deletion. Local Workers/D1 regressions cover delayed uploads and audit rollback. Production Access login and production publication were not performed.

Sanitised records are in [preview-display-name-results.json](preview-display-name-results.json). The diagnostic's authentication and sampling limitations apply to those records.

## Historical local international-name measurements

These are the earlier Linux workerd/native-encoder measurements, not deployed CPU and not an end-to-end measurement of the new browser encoder. Three fresh processes used 30 repeated images and 30 changed-title misses each:

| Name | First PNG CPU | Miss median | Miss p95 | Hit median |
| --- | --- | --- | --- | --- |
| 我的链接 | 47.1–47.9 ms | 5.8–8.2 ms | 7.2–9.7 ms | 0.29–0.31 ms |
| روابطي | 46.7–65.7 ms | 5.5–5.6 ms | 6.7–8.7 ms | 0.29–0.30 ms |
| 48 ideographs from distinct pages | 57.6–59.8 ms | 9.1–9.4 ms | 12.6–12.9 ms | 0.34–0.37 ms |

Wasm linear memory was 3.5–3.7 MB for ordinary names and 6.7 MB for the 48-page case. Inspector used heap reached 8.5 MB and backing storage 57.4 MB. These fields are not additive production memory measurements. Local fresh-process readiness took 467–534 ms wall time, including Miniflare startup. No local memory-limit errors occurred.

Font coverage remains that of Inter, the bundled Arabic font and the source SC font's CJK subsets. The accepted character set has not been narrowed to conceal unsupported glyphs in other scripts or colour emoji.
