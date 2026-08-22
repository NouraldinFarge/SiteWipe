# Performance evidence

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

No cleanup-speed claim is approved. The fast Node self-test and unit suite do not measure Chrome/Brave startup, service-worker wake behavior, API latency, page storage, real cleanup, or verification.

## Existing design controls

The runtime uses bounded query expansion, capped arrays and samples, operation timeouts, bounded concurrency, batched cookie operations, bounded OPFS traversal, a finite DNR rule range, and per-phase timing. In addition, the read-only preflight has a 45-second/750-query/100,000-observed-record ceiling and cleanup has a 210-second/1,000-query/250,000-observed-record ceiling. Crossing a ceiling prevents new ordinary browser work from being scheduled and is recorded as partial/unknown evidence; extension-owned shield and permission finalizers still run. These are defensive design controls—not measured performance results.

The adapter report contract records attempted, succeeded, failed, timed-out, unknown, skipped, and capped work separately. Counts are not summed into a fictitious “total changes” metric because cookies, tabs, URLs, files, origin buckets, and injected frames are heterogeneous and can overlap.

## Benchmark protocol

Run the benchmark only in disposable, unsigned test profiles with the loopback fixture documented in `tests/browser/README.md`. The fixture version is `sitewipe-synthetic-v1`; its `small`, `medium`, and `large` modes seed 8, 64, and 256 page-store records respectively. The operator must add and record the exact tab, cookie, history, and download counts required by the matrix below.

| Fixture       | Suggested bounded scale                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Small         | 2 target tabs, 8 cookies, 10 history URLs, 2 download records, LocalStorage + one IndexedDB + one cache                       |
| Medium        | 10 target/control tabs, 100 cookies/partition probes, 250 history URLs, 25 download records, multiple origins and page stores |
| Large bounded | At or near documented discovery/batch caps without exceeding them; record exact generated values                              |

For each scale:

1. Run Standard mode at least ten times from a clean fixture reset.
2. Run Expert mode at least ten times with each risky option in default detailed review, including every applicable acknowledgement and downloaded-file confirmation, and repeat a separately identified ten-run sample with the explicitly enabled direct setting. Direct runs must finish hidden preflight before **Clean now**, truthfully omit the typed phrase, and retain the same preflight-bound file IDs/live revalidation.
3. Force one service-worker termination and one browser restart recovery case.
4. Repeat a smoke subset in the exact Brave version under claim.
5. Verify unrelated controls and the SiteWipe DNR range after each run.

## Measurements to retain

- Windows edition/build, CPU, RAM, power mode, and whether other workload was controlled;
- Chrome/Brave full version and architecture;
- internal product version, source commit once Git exists, and artifact SHA-256;
- fixture generator version/seed and exact counts;
- popup first render and first usable response;
- total cleanup duration plus each report `phaseTimings` value;
- median, p95, maximum, warm/cold classification, and sample count;
- service-worker wakes/terminations where measurable;
- peak browser/extension-process memory where a reproducible method exists;
- timeouts, API errors, skipped/unsupported operations, verification states/residue, and orphan DNR IDs.

## Result schema

Final evidence belongs at `docs/evidence/performance-results.json` and should use this shape:

```json
{
  "schemaVersion": 1,
  "status": "pending",
  "measuredAt": null,
  "environment": {},
  "artifact": {},
  "fixtures": [],
  "limitations": [],
  "reviewerApproval": false
}
```

`status` must remain `pending` until raw synthetic run data is retained and reviewed. Do not interpolate, estimate, or derive browser metrics from source size or Node execution time.

## Performance acceptance criteria

No universal time target is asserted before baseline measurement. Release review should instead reject:

- unbounded growth with fixture size beyond documented caps;
- a timeout or error hidden as success;
- DNR residue, stuck job state, or control-site mutation after any run;
- material degradation across ten consecutive runs without explanation;
- a UI that becomes unusable or fails to announce progress/cancellation during long phases.
