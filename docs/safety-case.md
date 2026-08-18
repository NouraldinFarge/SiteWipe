# Safety case

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

This is a structured argument for the current candidate's safeguards. It is not a certification, guarantee of complete deletion, or public-release approval.

## Top-level claim

**Claim S0:** The candidate is designed to coordinate destructive browser operations only for a freshly normalized and authorized target, preserve explicitly protected data categories, expose uncertainty, and recover extension-owned request shields after interruption.

S0 depends on the claims below and on these assumptions:

- Chrome/Brave enforce their documented extension permission, process-isolation, and API semantics;
- the exact artifact under test matches reviewed source;
- the user reviews the complete displayed per-run scope, completes every applicable acknowledgement, explicitly approves it, and uses a non-compromised browser/device;
- browser APIs may fail, be unavailable, or expose incomplete state, and reports are read with those limits.

## Claims and evidence

| ID  | Claim                                                                                                                                                                     | Implementation evidence                                                | Automated evidence                                                                                                      | Browser evidence                          | Current judgement                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| S1  | Registrable cleanup does not collapse PRIVATE hosted tenants to a shared platform suffix.                                                                                 | `public-suffix.js`, pinned `public-suffix-data.js`, `domain.js`        | Official PSL corpus; named private-tenant and sibling-invariant tests                                                   | Pending disposable-profile fixture        | Code evidence passes; browser gate open       |
| S2  | Exact local targets retain scheme, host, and port for origin-scoped surfaces.                                                                                             | `domain.js`, `target-scope.js`, adapter guards                         | Localhost/IP/IPv6/property/page-scrub tests                                                                             | Pending                                   | Code evidence passes                          |
| S3  | No mutation-capable cleanup route runs before a preflight-backed, single-use detailed-review approval is consumed.                                                        | `cleanup-preflight.js`, message contracts, service-worker routing      | Read-only impact spy, final-click permission, retired-mode rejection, cancel/no-residue, single-use/context/token tests | Pending                                   | Code evidence passes                          |
| S4  | Expert expansion is not silently inherited by Standard mode; every valid Standard or Expert run displays complete scope/impact and requires explicit final approval.      | `cleanup-mode.js`, `cleanup-review.js`, `cleanup-authorization.js`     | Mode, elevated-scope, schema migration, forged quick/bypass, clock/target, and authorization-boundary tests             | Pending                                   | Code evidence passes; installed UX gate open  |
| S5  | Passwords, passkeys, bookmarks, Sync/account state, autofill, payment methods, and global/time-based deletion remain excluded.                                            | `safety.js`, `origin-storage.js`, manifest permission set              | Legacy self-test, origin guard, manifest tests, remote scans                                                            | Protected-data manual checks pending      | Code evidence passes                          |
| S6  | Untrusted page code cannot replace the live scrub's APIs through MAIN-world execution.                                                                                    | `cleanup-mode.js`, `page-scrub.js`                                     | Manifest/resource and page-scope tests                                                                                  | Pending hostile-page fixture              | Design implemented; browser gate open         |
| S7  | Unknown browser outcomes are never converted to verified zero.                                                                                                            | `verification-evidence.js`, `verification.js`, `report.js`             | All state combinations plus missing API, exception, and timeout adapter tests                                           | Pending forced-failure fixtures           | Code evidence passes                          |
| S8  | A runtime/origin failure cannot retain a High evidence label.                                                                                                             | `report.js`                                                            | Confidence regression tests                                                                                             | Pending                                   | Code evidence passes                          |
| S9  | Report storage/exports use one recursive redactor and refresh SHA-256 after transformation.                                                                               | `report-redaction.js`, `report-integrity.js`, `storage.js`, side panel | Canary, nested/free-form, export, debug, migration, returned-object tests                                               | Pending UI export inspection              | Code evidence passes                          |
| S10 | Report defaults are redacted, history-off, and latest-report 30-minute retention; reports are transient whenever private access is enabled or scope is observed.          | `constants.js`, `storage.js`, service-worker completion                | Default, on-read expiry, migration, normal-source/private-access review tests                                           | Alarm/restart/private persistence pending | Code evidence passes; lifecycle evidence open |
| S11 | DNR recovery intent survives install/clear uncertainty.                                                                                                                   | `dnr-shield.js`, `shield-recovery.js`                                  | Persist-before-mutate, timeout, unavailable API, orphan reconstruction tests                                            | Worker-kill/restart fixture pending       | Code evidence passes                          |
| S12 | Runtime packaging contains exactly the reviewed allowlist at ZIP root; the source archive contains the exact declared closure and neither archive follows symbolic links. | release scripts and allowlists                                         | Manifest/resource closure, package allowlist, symlink rejection, runtime/source reinspection and exact parity           | Unpacked load pending after final build   | Code evidence passes                          |
| S13 | Temporary host access remains attributable across service-worker/browser restart and pre-existing grants are never selected for automatic removal.                        | `permission-leases.js`, `cleanup-preflight.js`, service worker         | Mixed-ownership release, failed/unknown removal, restart, malformed/broad/inconsistent lease, and approval-tamper tests | Grant/crash/restart fixture pending       | Code evidence passes; browser gate open       |
| S14 | Stale messages, operation-budget exhaustion, and concurrent local writes cannot silently authorize extra work or overwrite cancellation/report state.                     | message contracts/client, operation control, storage/service worker    | Protocol/correlation/timeout, duration/query/record ceiling, cancellation propagation, and storage race tests           | Worker suspension/message timeout pending | Code evidence passes; lifecycle evidence open |
| S15 | A completed browser cleanup is not relabeled failed only because final job/report bookkeeping fails.                                                                      | service-worker completion/failure finalizers                           | Report-persistence fault injection and emergency-completion regression                                                  | Forced installed storage failure pending  | Code evidence passes                          |

## Safety invariants

These are release-blocking invariants, not optional quality goals:

1. A target host matches only itself or a subdomain separated by `.`.
2. A PRIVATE suffix tenant is a registrable boundary; siblings never enter any destructive or verification candidate set.
3. Unknown/public-suffix-only targets cannot authorize destructive work.
4. Exact-origin matching never crosses scheme or effective port.
5. Cookies are acknowledged as host-scoped even for exact-origin cleanup.
6. Every associated target is normalized, protected-target checked, preflight-bound, displayed separately, and acknowledged when required.
7. Approval precedes job creation, recovery mutation, DNR installation, page injection, tab closing, or data removal.
8. Approval tokens are short-lived, single-use, and context-bound.
9. A complete per-run review is mandatory in Standard and Expert modes. Legacy bypass settings are dropped, bypass-era session records are invalidated, and message/review/preflight/authorization layers reject non-`detailed_review` modes.
10. Only one live approval may own temporary host access. A durable canonical lease exists before any prompt, classifies requested access as a disjoint pre-existing/temporary partition, and is forgotten only after every temporary pattern is proved absent.
11. Every origin/type plan and candidate tab is revalidated against the approved target immediately before mutation.
12. File removal applies only to IDs captured by the preflight as matching and complete, revalidated at execution, and separately approved by typing the normalized target.
13. No cleanup code requests `formData`, passwords, bookmarks, passkeys, Sync, or profile-wide time ranges.
14. Verification failure/timeout/absence remains nonzero uncertainty.
15. SiteWipe-owned DNR state is forgotten only after the owned range is proven empty.
16. Completed reports are not persisted whenever private access is enabled or private scope is observed.
17. A transformed report's checksum covers the transformed content and is never described as a signature.
18. Versioned request/response correlation rejects stale messages; a timeout is an uncertain outcome and cannot silently prepare or authorize a duplicate run.
19. Run-wide duration/query/record ceilings and cooperative cancellation stop scheduling new ordinary work; safety finalizers remain allowed to reconcile extension-owned state.
20. Human browser, performance, and accessibility evidence is reset on every version bump and is never rebound automatically by the artifact builder.

## Residual risks

- Sites can recreate state after the shield is removed or through mechanisms Chrome does not expose.
- Partitioned-cookie discovery depends on browser-exposed partition metadata and bounded probes.
- Live-page APIs, protected/PWA storage, OPFS, service workers, and private stores vary by browser/version.
- Cancellation occurs between major phases and cannot undo completed deletion.
- Mandatory review is code- and contract-tested, but installed-browser evidence is still needed to prove focus, acknowledgement, permission-prompt, stale-page, popup-close, and alternate-route behavior for the exact artifact.
- A Chrome API can finish after the extension's timeout.
- Browser permission/content-setting rules, recently closed entries, protocol handlers, identity grants, device grants, favicons, omnibox/top-sites data, and low-level network state may remain.
- A permission granted at the final click can remain temporarily if the popup or worker stops before submitting cleanup; the durable lease survives session loss and schedules reconciliation on a later wake, but Chrome can refuse/obscure removal and installed-browser evidence is still required.
- Browser state can change after the final adapter revalidation but before an asynchronous Chrome mutation completes.
- Redacted records can retain identifying metadata or unknown patterns.
- Automated logic tests do not substitute for real installed-browser evidence.

## Release position

The P0 consent defect is closed in the current source by removing the bypass rather than approving it. The safety argument remains incomplete until the browser matrix, accessibility run, benchmark, provenance audit, license/public-version/name-collision decisions, authentic media, remote controls, and final artifact evidence are retained. See [ADR 0009](./decisions/0009-mandatory-cleanup-review.md), the [historical superseded record](./decisions/0004-complete-review-bypass.md), and [release readiness](./release-readiness.md).
