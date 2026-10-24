# Preview rendering performance

These are local Linux workerd measurements, not Cloudflare production CPU billing or proof that Free requests cannot exceed their limit. No deployment was performed. The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) give Free HTTP requests 10 ms CPU and isolates 128 MB memory, with some flexibility for infrequent overruns.

## Reproduce

Use the pinned patched Node/Bun versions, install the frozen lockfile and run:

```sh
bun run profile:preview --output verification-artifacts/preview-profile.json
```

The script compiles a benchmark-only Worker and runs three fresh workerd processes, each with one cold PNG request, 30 identical requests and 30 requests with changed titles. It uses direct local HTTP sockets and Linux `/proc/PID/task/PID/schedstat` nanosecond accounting for the workerd main thread. The Node client is outside that process. Results include HTTP/runtime overhead and exclude background compiler threads and the application router/D1 checks. CPU deltas are separate from wall-clock latency. The report records the CPU model, runtime versions, revision and individual samples.

The inspector reports V8 heap/backing storage. Benchmark-only instrumentation also reads the Wasm linear-memory allocation. These are separate observations; neither total process RSS (which includes runtime overhead and other isolates) nor the sum of these fields is a production per-isolate memory measurement. The diagnostic Worker and instrumentation are never included in the deployed entry point.

## Shared renderer results, 24 October 2026

Original source: `36ea482337c1c53003c87f5128aaf069c52035fa`. Local workerd `1.20261024.1`, Node `26.12.1`; three fresh processes. The original 1200 × 630 pipeline spent about 18–19 ms in Wasm PNG compression alone. Whole-image warm medians were 26.0–26.8 ms CPU, with first-render CPU 74.4–94.9 ms.

The revised pipeline keeps the same layout at 600 × 315, uses native level-1 deflate, and caches only derived PNG bytes after primary-D1 availability validation. Three runs measured:

| Path | Local main-thread CPU |
| --- | --- |
| First PNG in a fresh process | 41.2–44.4 ms |
| Uncached, changed title: median | 5.4–5.6 ms |
| Uncached, changed title: p95 | 7.2–9.4 ms |
| Uncached, changed title: maximum observed | 10.4 ms |
| Repeated image: median | 0.21–0.23 ms |

The sample PNG was approximately 13 KiB. Wasm linear memory was 3.34 MB after the run; inspector used heap was 1.6 MB and backing storage 6.3–7.8 MB. PNG caching is capped at 512 KiB, independent of font/renderer memory.

## Deployment limitation

The optimisation removes the sustained warm-render bottleneck. Cold local renders still exceed 10 ms, and one changed-title sample also exceeded it. A cache miss must still render; the cache does not make cold CPU safe. Free compatibility therefore remains a deployment risk, not a confirmed production failure or a promise of compatibility. Do not infer production CPU from wall time, and do not silently switch to a paid plan. A future authorised staging deployment must inspect actual Workers invocation CPU, cold requests, eviction and diverse titles before claiming Free-limit compliance. No redirect or availability cache is used to hide this risk.
