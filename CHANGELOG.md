# Changelog

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

This log distinguishes private engineering candidates from public releases. No version listed here has been published as an approved public release.

## Unreleased

## 1.11.2 — private release-candidate work — 2026-08-17

### Licensing, provenance, and private staging

- Added the owner-selected MIT license and bound the exact license bytes to package metadata, source packaging, automated validation, and publication gates.
- Recorded the owner's copyright, provenance, third-party notice, dependency-license, icon, and private-material confirmations while preserving the separate browser, media, remote-control, and final-publication gates.
- Recorded authorization for the first truthful commit and private GitHub staging upload without authorizing public visibility, a tag, a release, a store submission, or professional-profile use.

## 1.11.1 — private release-candidate work — 2026-08-17

### Release integrity

- Normalized the release-readiness ledger after the 1.11.0 transaction so the final source closure satisfies the enforced formatting contract without reusing the earlier candidate version.

## 1.11.0 — private release-candidate work — 2026-08-17

### Safety and consent

- Removed the complete cleanup-review bypass from Standard and Expert modes. Every run now requires a fresh detailed scope-and-impact screen and an explicit final approval before target access is requested or destructive work can begin.
- Invalidated all older preflight records, retired quick/bypass message modes, dropped the legacy setting during migration/import, and added a publication gate that rejects reintroduced runtime bypass signals.
- Isolated final reviewed-cleanup report initialization in a small authorization module that independently rejects missing, quick, bypass, stale-clock, and malformed-target approvals before orchestration can continue.

### Privacy, verification, and tests

- Expanded deterministic property coverage for PRIVATE hosted tenants, associated-target permutations, credentials, ports, IPv4/IPv6 inputs, adapter agreement, and the documented host-scoped cookie exception.
- Strengthened recursive redaction for credentials, identities, destinations, secrets, nested unexpected fields, private paths, and free-form API errors; private/incognito-context reports now fail closed at the storage boundary.
- Enforced latest-report expiry during migration, reads, and service-worker startup, including the exact 30-minute boundary.
- Replaced ambiguous user-facing confidence wording with **Verification evidence confidence** and made the main check pipeline run the fixed-seed property suite.

### Release integrity and documentation

- Added the authorization module to the runtime allowlist, refreshed the manifest description, and reconciled the architecture, privacy policy, safety case, permission policy, issue register, evidence ledgers, and publication drafts with mandatory review.
- Preserved historical bypass records as explicitly retired evidence; no safety approval was fabricated.

## 1.10.2 — private release-candidate work — 2026-08-16

### Release evidence

- Moved volatile test totals, coverage percentages, and artifact counts out of stable policy documentation and into the mutable exact-version evidence record, preventing validation itself from creating an endless version-bump cycle.

## 1.10.1 — private release-candidate work — 2026-08-16

### Identity and provenance

- Recorded the owner's explicit selection of **SiteWipe** as the custom product identity without claiming marketplace uniqueness or legal clearance; retained two exact-name Chrome Web Store listings and one Firefox listing as collision evidence.
- Began closing the remaining non-browser provenance gates while preserving separate owner/legal approval requirements.
- Bound a complete 406-package development-license inventory to the lockfile, exact license counts, the one legacy metadata exception's installed MIT text, and the single disabled install-script package; the loadable runtime continues to contain no npm dependencies.
- Completed the locally verifiable provenance tranche for the 181-file source closure, notices, pinned PSL, editable icon, dependency graph, development SBOM generation, and private-material/symlink exclusions while leaving copyright, confidentiality, license compatibility, and publication assertions for the owner.
- Strengthened publication gates to validate identity collision evidence, exact public-version approval, technical provenance/lockfile binding, remote CI and CodeQL, hosted privacy policy, and the protected release environment.
- Updated transactional version markers so future bumps preserve the owner-approved SiteWipe identity wording while continuing to advance every private candidate reference atomically.
- Made the version transaction refresh the lockfile-bound dependency-license evidence in the same journaled promotion, preventing a version-only lockfile change from leaving provenance validation stale.
- Extended version enforcement from the 49-file runtime to every stable release input—including scripts, CI, tests, documentation, assets, configuration, lockfile, and third-party material—while excluding mutable post-build evidence and owner-approval records to avoid circular artifact invalidation.

## 1.10.0 — private release-candidate work — 2026-08-16

### Safety and reliability

- Added a durable, restart-safe target-permission lease written before any browser prompt. It preserves pre-existing grants, validates canonical requested/pre-existing/temporary partitions, defers live prepared reviews, and retains recovery state until Chrome/Brave proves every temporary pattern absent.
- Recompute and validate the entire stored approval snapshot before cleanup—including effective settings, normalized/associated targets, permission ownership, file IDs, bypass eligibility, timestamps, context, and confirmation requirements—so corrupted or tampered session state fails closed.
- Added run-wide preflight/cleanup duration, query, and observed-record budgets; propagated cancellation-check failures; and inserted cooperative cancellation/budget checks inside discovery, cookie, origin, history, download, tab, frame, and page-scrub loops.
- Revalidated each tab immediately before zoom, mute, pin, or close mutation; closed tabs individually; and retained downloaded-file records whenever approved on-disk deletion fails, times out, or remains unknown.
- Serialized local read-modify-write state transitions, made cancellation monotonic across late progress updates, preserved the active latest report when deleting report history, and separated completed browser work from report/job bookkeeping failures.
- Standardized adapter evidence as attempted/succeeded/failed/timed-out/unknown/skipped/capped outcomes, removed the misleading heterogeneous “total browser changes” sum, and capped verification confidence whenever any required surface is incomplete.

### Messaging, UI, and historical streamlined behavior (retired in the next candidate)

- Added versioned, correlated message envelopes, sender/payload/size validation, type-specific response deadlines, structured error classification, and a transitional legacy envelope path for already-open extension pages.
- Reused a versioned isolated-world progress-overlay receiver instead of reinjecting the full renderer for every phase, while retaining navigation-safe reinjection and target-tab revalidation.
- Historical candidate behavior: retained a complete cleanup-review bypass in Standard and Expert modes after pre-click preflight. This consent model was removed before publication; current candidates require a fresh detailed review and final approval on every run. The uncertain-response duplicate-run guard remains.
- Clarified four-surface verification, partial/unknown completion, history-vs-latest-report deletion, permission-recovery status, Settings dependencies, and private-candidate status throughout popup, side panel, and Options.

### Tests, security, and release integrity

- Expanded unit/contract coverage for durable permission recovery, approval tampering, permission-inspection failure, operation budgets, messaging correlation/timeouts, storage races, tab navigation races, downloaded-file ordering, and completion fault injection; fixed the test runner so child-process failures set a failing exit code.
- Enforced repository coverage floors of 80% lines/statements, 55% branches, and 70% functions, and expanded checked-JavaScript type coverage across the service-worker adapters and release-critical modules.
- Replaced regex-only runtime JavaScript review with an AST-based forbidden-capability scan and expanded secret/private-path scanning to the complete declared source archive closure.
- Made version changes a journaled, recoverable multi-file transaction; every bump resets installed-browser, accessibility, and performance evidence instead of carrying it to new bytes.
- Built releases in a staging directory promoted atomically to canonical `dist/current/`, added `current-release.json`, rejected stale/extra current outputs and symbolic links, and verified exact path/byte/timestamp parity for both runtime and full source ZIPs.
- Prevented builds from rewriting human browser/performance/accessibility artifact hashes, moved the manual publication gate after rebuild and verification, and required exact-artifact reviewer approval plus complete automated, provenance, media, browser, accessibility, performance, and remote evidence.

## 1.9.9 — private release-candidate work — 2026-08-16

- Historical candidate behavior: replaced conditional quick eligibility with an off-by-default setting that omitted the detailed screen in both modes. This behavior was never approved for publication and is now retired.
- Historical candidate behavior: prepared preflight before the primary action and submitted cleanup without a second SiteWipe confirmation screen. Current candidates instead render the complete review and require its final activation.
- Historical candidate behavior covered elevated scope and therefore remained publication-blocking. The implementation, setting, message mode, and approval schema were removed rather than approved.
- Product identity, public version, license/source model, remote repository, browser evidence, accessibility evidence, performance evidence, media, provenance/attestation, and owner approval remain gated.

## 1.9.8 — private release-candidate work — 2026-08-16

### Safety

- Replaced the handwritten suffix subset with a pinned full Public Suffix List implementation including PRIVATE rules, wildcard/exception handling, and official corpus tests.
- Added deterministic scope-and-impact review, single-use approval tokens, explicit associated/local/protected/file acknowledgements, and tests proving no destructive mutation before approval.
- Moved target host-permission requests to the final approval gesture, limited cleanup to one live review, tracked pre-existing access per origin, and released only review-acquired patterns on cancellation, expiry, reset, failure, or completion.
- Added a final origin/type mutation guard plus live tab revalidation so changed origins and tabs that navigate away cannot inherit stale review authority.
- Added exact message and stored-state schemas, protected browser-service checks, and a Standard/Expert enforcement boundary.
- Isolated live-page cleanup from page JavaScript and retired the legacy `MAIN`-world path.
- Fixed a private-tenant `www.` expansion defect in the live-page matcher.
- Added bounded cookie discovery and ensured explicit reviewed origins are never discarded by discovery caps.
- Reserved a DNR rule range, persisted recovery intent before mutation, and retained/reconstructed recovery state until diagnostics prove the range empty.

### Privacy and evidence

- Centralized structured and free-form report redaction across storage, exports, troubleshooting, debug records, and support payloads.
- Enabled redaction by default, set latest-report retention to 30 minutes, added immediate deletion, and prevented report persistence whenever private-window access is enabled or private scope is observed.
- Extended free-form scrubbing to generic POSIX paths and probable filenames, and made **Forget report now** remove the current report from optional history as well as the latest-report slot.
- Replaced non-cryptographic digest wording/behavior with SHA-256 content checksums that are explicitly not signatures.
- Reworked verification into explicit zero, residue, unsupported, not-attempted, timed-out, failed, and unknown states; incomplete checks cannot produce a false zero or High label.

### Permissions and packaging

- Removed required all-sites host access. Target host patterns are requested just in time and newly granted access is released after a run.
- Removed `sessions` and legacy `contentSettings`; made `webNavigation` optional.
- Added manifest, remote-code, package-allowlist, resource-closure, syntax, type, lint, HTML, CSS, property, accessibility-contract, and deterministic ZIP gates.
- Added root-level manifest packaging, checksum inventory, runtime SBOM, release notes, unsigned provenance input, and byte-equivalence verification.

### UX, accessibility, and architecture

- Added reviewed destructive scope, exact file confirmation, honest cancel behavior, live status regions, labeled field groups, ARIA tabs, roving keyboard focus, forced-colors support, reduced motion, larger targets, and corrected CTA contrast.
- Split the cleanup monolith into scope discovery, cookies, origin storage, history, downloads, tab state, live-page scrub, progress overlay, verification, operation control, DNR lifecycle, and shield recovery modules.

## Earlier private prototypes

Local prototypes `1.9.0` and `1.9.2` through `1.9.7` existed outside this clean repository. `1.9.1` was not found in the supplied local archives. None are represented as public releases.

Private prototypes `1.9.4` through `1.9.7` included a browser-profile-wide `formData` cleanup path. That path was retired because Chromium can couple it to saved autofill profiles and payment cards, contradicting the project's protected-data boundary.
