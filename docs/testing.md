# Testing strategy and evidence

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

The exact latest local run date, environment, counts, coverage, and artifact binding live in `docs/evidence/automated-validation-current.json` and its referenced dated record. Browser claims require retained disposable-profile evidence and are not inferred from Node tests.

## Test layers

| Layer                   | Purpose                                                                                               | Current mechanism                       | Evidence status                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| Characterization        | Preserve reviewed legacy safety behavior while refactoring                                            | `src/test-harness/release-selftest.mjs` | Passing locally                                |
| Unit/contract           | Pure scope, report, state, message, review, and adapter behavior                                      | Node test runner under `tests/`         | Passing locally                                |
| Chrome API mocks        | Stateful contracts for every audited extension API namespace                                          | `tests/helpers/chrome-mock.mjs`         | Worker routing smoke passes; not browser proof |
| Property                | Explore arbitrary bounded inputs and matcher invariants                                               | `fast-check` tests                      | Passing locally                                |
| Official conformance    | Validate PSL behavior against upstream cases                                                          | Pinned `test_psl.txt` corpus            | Passing locally                                |
| Static quality          | Syntax, TypeScript/JSDoc, ESLint, Prettier, HTML, CSS, lockfile-bound dependency licenses             | npm scripts                             | Passing locally                                |
| Release validation      | Manifest, resources, AST remote-code scan, full source closure, archive root/parity, evidence binding | release scripts and tests               | Final local artifact rebuild pending           |
| Accessibility contracts | Labels, ARIA structure, focus/motion/contrast CSS contracts                                           | Node source/DOM contract tests          | Passing; automated browser scan pending        |
| Browser fixtures        | Synthetic tenant/control/storage/download data                                                        | Loopback fixture server                 | Infrastructure passes; installed run pending   |
| Chrome integration      | Actual APIs, persistence, incognito, worker interruption                                              | Disposable Chrome profile               | Pending retained run                           |
| Brave compatibility     | Actual Brave behavior, not inferred from Chromium                                                     | Disposable Brave profile                | Pending retained run                           |
| Performance             | Browser fixture durations and failure/residue data                                                    | Bounded benchmark protocol              | Pending measurement                            |

## Local commands

```powershell
npm ci --ignore-scripts
npm run check
npm run test:property
npm run test:coverage
npm run browser:fixture
npm run build:release-candidate
npm run verify:release-candidate
```

`npm run check:publication-gates` is deliberately separate and expected to fail until human and remote evidence exists. A failure there is an accurate release status, not a failing unit test. Its independent-review check reads the designated GitHub pull request live and rejects self-review, draft/stale heads, read-only reviewers, malformed review metadata, dismissed approvals, and later changes-requested decisions.

## Current automated result

The exact current version, named-test totals, failure/skip counts, property result, environment, coverage, and artifact binding are maintained in the active machine-readable record under `docs/evidence/`, which is intentionally mutable after validation. A release candidate requires the legacy self-test, complete Node runner, and separate property invocation to pass with zero failures or skips. These source-level results must not be treated as browser-performance evidence.

Property tests default to the fixed seed `20260817`; `PROPERTY_SEED` may override it for replay/search. Every failure reports the seed and fast-check shrink path so the exact counterexample can be rerun. The main `npm run check` pipeline invokes the property suite, while CI retains the separate named step for visibility.

Covered high-risk cases include:

- complete upstream PSL conformance plus PRIVATE tenants, wildcard/exception rules, Unicode/punycode, unknown suffixes, local/IP origins, and generated lookalikes;
- a sibling-tenant invariant across target origins, tabs, page scrub, cookies, history, downloads, DNR, and verification;
- central redaction of schema fields, free-form text, nested values, debug/support records, every export transform, privacy migration, and the report returned after storage;
- all verification states, missing APIs, exceptions, timeouts, residue, incomplete checks, and confidence caps;
- read-only preflight, mandatory Standard/Expert detailed review across elevated and uncertain scope, forged quick/bypass-mode rejection, legacy setting and session-schema invalidation, stored-approval tampering, cancel-without-mutation, host-permission withholding/inspection failure, token replay/expiry/context checks, and routing of all cleanup mutations behind token consumption;
- one-live-approval enforcement, final-review-click host requests, explicit two-stage SiteWipe interaction, uncertain submitted-response handling, settings-change invalidation, durable mixed-ownership permission release, failed/unknown/restart recovery, malformed/broad lease rejection, reset cleanup, final origin guards, and live tab revalidation;
- an independent reviewed-cleanup authorization boundary that rejects non-detailed modes, malformed targets, invalid/retrograde clocks, and records distinct preflight/final-review timestamps plus associated/file evidence;
- cookie query bounds, partition variants, paths, identifiers, missing API, and exceptions;
- browsing-data origin/type guard and exact forwarded Chrome arguments;
- DNR owned-range construction, persist-before-mutate, timeout uncertainty, proven-zero clearing, unavailable API, and orphan reconstruction;
- stored-state schemas/transitions, serialized settings/report/job/shield updates, monotonic cancellation, versioned/correlated message senders/payloads/responses/timeouts, operation budgets, complete source/runtime closure, runtime and stable-release-input version fingerprints, lockfile-bound dependency-license evidence, CSP/AST remote-code checks, evidence-reset/binding contracts, and accessibility source contracts;
- downloaded-file deletion/record ordering, per-tab navigation races, page-scrub timeouts, report-persistence completion faults, transactional version-file crash recovery, and source-archive symbolic-link rejection;
- one centralized stateful Chrome test double covering browsing data, cookies, tabs, history, downloads, scripting, navigation, DNR, storage, sessions, alarms, side panel, and private-access status, plus service-worker message routing.

## Synthetic fixture infrastructure

`tests/browser/fixture-server.mjs` serves only on loopback by default. Its host-aware page can seed bounded localStorage, sessionStorage, IndexedDB, Cache Storage, service-worker cache, Storage Bucket, OPFS, ordinary/partitioned-cookie attempts, and a harmless download where the browser exposes each API. Small, medium, and large page-store scales are deterministic. See `tests/browser/README.md` for disposable-profile host mapping and secure-context limitations.

The fixture server has a Node contract test, but no installed browser was launched in this audit environment. Its existence therefore does not change Chrome/Brave status from pending and cannot supply a browser version, UI result, destructive-operation trace, or performance number.

## Required installed-browser fixture matrix

Use only synthetic origins and a disposable profile. Retain machine-readable output with OS, browser build, extension artifact hash, fixture seed, timestamps, and individual assertions.

| Fixture                          | Chrome                        | Brave              | Required observation                                                                                                                                                                |
| -------------------------------- | ----------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registrable site + subdomain     | Required                      | Smoke              | Target data changes; lookalike remains                                                                                                                                              |
| Mandatory Standard/Expert review | Required                      | Required           | Read-only preparation renders the complete review; a distinct **Clean now** activation is required; forged quick/bypass routes fail closed; a native target prompt may still appear |
| PRIVATE sibling tenants          | Required                      | Required           | Selected tenant changes; sibling remains across all exposed surfaces                                                                                                                |
| Unknown/public suffix            | Required                      | Smoke              | Review rejected; no job/rule/mutation                                                                                                                                               |
| Exact localhost scheme/port      | Required                      | Smoke              | Origin state does not cross port/scheme; cookie host limitation displayed                                                                                                           |
| Associated target                | Required                      | Smoke              | The complete review explicitly acknowledges displayed scope; cleanup rejects missing or stale acknowledgement and remains bound to the exact preflight scope                        |
| Private access disabled          | Required                      | Required           | Private-origin cleanup rejected                                                                                                                                                     |
| Private access enabled           | Required                      | Required           | Targeted private fixture data changes; completed report not persisted                                                                                                               |
| Worker termination               | Multiple phases               | One representative | Interrupted status; no silent resume; shield recovery succeeds                                                                                                                      |
| Permission grant + restart       | Before submit and during run  | One representative | Only temporary patterns are released; pre-existing grants remain; unknown removal keeps a visible durable lease                                                                     |
| Popup close during run           | Required                      | Smoke              | Job continues/finishes visibly through persistent state                                                                                                                             |
| Ten consecutive runs             | Required                      | Required           | No orphan DNR, stuck job, or accumulating state                                                                                                                                     |
| Forced API error/timeout         | Required where harness allows | Smoke              | Partial/failed evidence, never false zero/High                                                                                                                                      |
| Protected data                   | Required                      | Required           | Synthetic bookmark/password/autofill/payment/Sync-safe checks remain unchanged                                                                                                      |
| Report expiry/restart            | Required                      | Smoke              | Latest redacted report expires after configured window/on read                                                                                                                      |
| Accessibility                    | Required                      | Smoke              | Keyboard-only path, focus, screen reader names, axe scan, zoom, forced colors/reduced motion                                                                                        |

## Integration-test safety rules

1. Create a new browser profile in a test-output directory excluded from Git.
2. Do not sign in or enable Sync.
3. Do not import browser data.
4. Serve fixtures from synthetic local hostnames or loopback ports; never use personal sites.
5. Create only disposable cookies, storage, history entries, records, and files.
6. Record the exact unpacked source tree or ZIP SHA-256.
7. Assert the unrelated control fixture before and after every destructive run.
8. Inspect `chrome.declarativeNetRequest.getSessionRules()` for owned IDs after every terminal path.
9. Delete the disposable profile only after retained redacted evidence has been copied to `docs/evidence/`.

## Failure injection

Browser adapters accept injected dependencies in unit tests. Installed-browser failure injection should use test-only fixture controls or controlled extension reload/worker termination; never weaken production guards. A timeout result must state that the underlying operation may still be running.

## Coverage interpretation

The repository enforces minimum overall coverage of **80% statements, 80% lines, 55% branches, and 70% functions**. Exact current percentages belong in the active automated-evidence record rather than this stable policy document. Browser-dependent adapters and the service worker still require installed-browser evidence regardless of aggregate coverage. Low-value percentages do not waive missing installed-browser branches.

Coverage is a navigation aid, not a safety score. Pure shared modules are expected to have high branch coverage. Browser adapters and the service worker require installed-browser coverage/evidence, so a single repository-wide percentage can be misleading. Any threshold should be split by testable layer and must not exclude files merely to inflate the number.

## Evidence retention

Automated CI logs, coverage, integration JSON, screenshots, accessibility results, and package verification should be downloadable workflow artifacts. Only synthetic, redacted evidence belongs in Git. Private profiles, raw reports, downloads, videos with identifiers, and extension IDs must stay outside the repository.
