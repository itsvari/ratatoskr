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
