# Changelog

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

This log distinguishes private engineering candidates from public releases. No version listed here has been published as an approved public release.

## Unreleased

## 1.11.46 — public-source prerelease work — 2026-08-21

### Permission-expiry and partition-preservation hardening

- Close the exact late-grant expiry gap observed in the installed 1.11.45 Standard run and the deadline-admission and stale-control defects found during 1.11.46 review. After the native prompt settles, the initiating popup reconciles the authenticated capability/nonce-bound worker outcome before choosing its copy: an admitted running job or terminal report remains authoritative, and only a proven canceled handoff with `cleanupStarted: false` plus strict temporary-access absence may say that no cleanup started and access was released. An unprovable outcome retains the binding, locks fresh cleanup, and directs the user to the current job/report or Options without claiming admission or release. The worker—not the popup—settles or revokes only preflight-classified temporary exact origins, and the popup retires stale review controls while keeping the outcome guidance visible.
- Add a distinct read-only `chips.localhost` partition-preservation probe. The legacy `embed=1` route remains setup-only and auto-seeds, while `/partition-probe` embeds a snapshot-only frame that ignores `autoseed`, exposes no seed/reset API, disables and hides mutation controls, removes the download target, emits no seeding cookie, and documents the same-scheme/site/port before-and-after protocol.
- Extend popup, service-worker, fixture-server, routing, accessibility/message-contract, and pure fixture-policy regressions for missed permission-event wakes, expired arm rejection, exact temporary-grant release, zero cleanup/file mutation, and non-reseeding probe behavior. The 1.11.46 source transaction and ChatGPT in-app Browser synthetic validation are recorded separately; installed Chrome/Brave claims remain pending.

## 1.11.45 — public-source prerelease work — 2026-08-21

### Final corrective-candidate evidence integrity

- Mark 1.11.44 as superseded before complete validation, artifact construction, or installed-browser testing. A post-transaction lint correction and the independent evidence audit changed stable release inputs, so the corrective source must advance again rather than reusing a fingerprinted version.
- Preserve automated validation append-only across same-day version changes. Restore the completed 1.11.42 record byte-for-byte from its frozen source archive, archive a legacy active record under its exact previous version, create a distinct version-qualified next record, and advance the pointer atomically without overwriting historical evidence.
- Reset candidate-sensitive accessibility, dependency-audit, development-SBOM, and technical-provenance claims instead of mechanically carrying them forward. Tighten publication checks for exact-version/source-push approval, hosted privacy-policy byte parity, complete passed Chrome/Brave matrix coverage, retained performance samples, integrity-bound media, and current accessibility/dependency bindings. Keep exact-version owner approval and every public-release action blocked rather than inventing a decision.
- Retain the Chrome 151 action-popup sentinel correction and its independent normal/private replay and authorization audit. The next exact artifact still requires the full automated transaction and a fresh installed non-destructive detailed-review gate before any cleanup action is requested.

## 1.11.44 — public-source prerelease work — 2026-08-21

### Corrective-candidate fingerprint normalization

- Mark 1.11.43 as superseded before complete validation, artifact construction, or installed-browser testing because five stable release inputs still required the repository's mechanical formatting pass after that version transaction. Preserve its action-popup correction in source, normalize those inputs first, and advance monotonically so the next candidate's runtime and complete stable-input fingerprints are frozen only after formatting.

## 1.11.43 — public-source prerelease work — 2026-08-21

### Chrome action-popup context correction

- Retain the exact installed SiteWipe 1.11.42 Standard failure as historical evidence. Chrome `151.0.7922.172` loaded the byte-verified 55-file runtime ZIP (`SHA-256 86375132D0B021517305DC9DC78F3C109BBD5A3D5FDCB4DE8C0D93F79FE23549`), but two fresh **Review cleanup** attempts failed with “Chrome returned a malformed or mismatched SiteWipe popup context. Reopen SiteWipe.” Chrome's canonical action-popup `ExtensionContext` uses `tabId: -1` and `windowId: -1`; the 1.11.42 worker and mock incorrectly required its `windowId` to be the positive source browser-window ID. The failure preceded review, permission prompting, lease creation, cleanup admission, shield/DNR work, or browser-data mutation. The protected 63-byte fixture download remained unchanged, downloaded-file deletion and incognito access remained off, and no host grant, job, report, or shield persisted.
- Model Chrome action popups with a distinct required `contextId`, optional/different `documentId`, exact popup URL/origin, `tabId: -1`, and `windowId: -1`. Resolve exactly one exact-URL `POPUP` context and bind only its opaque `contextId`; independently verify the positive source browser-window ID and private state through `chrome.windows.get`. Under SiteWipe's `spanning` incognito mode, keep the popup extension-profile flag distinct from the source window's private state.
- Extend the behavioral and static publication contracts with the canonical Chrome context shape, an absent-sender-document regression, no-autofill malformed context fixtures, source-window/private separation, inspection API failure cases, exact type/URL/unique-result enforcement, complete liveness revalidation, and mutations that restore the incompatible window-ID assumption or optional `sender.documentId` authority. The corrected source requires a new version, reproducible artifacts, complete validation, and a fresh installed non-destructive review gate before any cleanup is approved.

## 1.11.42 — public-source prerelease work — 2026-08-21

### Popup-binding publication contract

- Align the static publication contract with the external cleanup message's worker-minted popup context and capability credentials. Continue rejecting caller-controlled skip or raw cleanup-authority fields, require the current popup binding before review consumption or browser mutation, and keep the armed continuation selectable only by worker-internal state rather than message payload.
- Extend the contract's mutation checks for weakened binding validation, caller-created or undersized credentials, raw durable persistence, and externally selectable internal continuation. Complete fresh validation/evidence, artifact construction, and exact installed-browser validation remain pending for the next corrective candidate.

## 1.11.41 — public-source prerelease work — 2026-08-21

### Candidate-history correction

- Record that SiteWipe 1.11.40 was superseded before the complete validation/evidence transaction, release-artifact construction, or exact installed-browser validation ran. Its source audit remains historical source evidence only and must not be presented as artifact or installed evidence.
- Advance the popup-context remediation monotonically in the current corrective candidate rather than reusing or relabeling 1.11.40. Exact-artifact installation and the required disposable-browser matrix remain pending for that current candidate.

## 1.11.40 — public-source prerelease work — 2026-08-21

### Popup-context authorization — independent source audit passed; 1.11.40 installed validation pending

- Retain the exact installed SiteWipe 1.11.39 Standard failure. In Chrome `151.0.7922.172`, `sitewipe-unreleased-candidate-1.11.39.zip` (SHA-256 `BAF78DEF05AC5E6960CD5FD98C0FF0CBDDA71688C6F0259C0A0C2A9E5D56A337`) rejected **Review cleanup** with “The popup document preparing Chrome target access could not be verified. Reopen SiteWipe.” The failure occurred before the detailed review, native permission prompt, handoff, temporary-access lease, cleanup job, request shield, DNR mutation, or browser-data mutation. Fixture storage was not resnapshotted after the failed attempts, so no full post-run fixture-equivalence claim is made; incognito and downloaded-file deletion stayed off, and an independent rehash proved the protected downloaded file unchanged.
- Correct the identity model exposed by that run. Chrome's `runtime.MessageSender.documentId` is optional and an action-popup message can omit it, so a fabricated test-only document ID is not a valid production requirement. Do not weaken the guard to URL-only or accept an unbound null identity.
- At preparation, require the exact popup sender URL with no `sender.tab`, use a bounded worker-side `runtime.getContexts()` query to resolve exactly one matching `POPUP` context for the source window and private state, and bind its required `contextId`. Mint a high-entropy capability for that review, persist only its SHA-256 digest, return the raw value only to popup memory, and require it for arm and explicit prompt settlement/cancellation. A same-context response retry may rotate the capability only before any handoff or pending arm. A pregranted review may rebind after the old context is proved gone; a missing-access review is never transferred to a different popup and instead becomes a non-runnable reconciliation obligation until a fresh browser-session/review boundary. On nonce-bound durable admission, only the popup context ID and capability digest move to the active job for authenticated terminal replay by the surviving initiating popup; the raw capability never enters review, job, report, or debug storage.
- Preserve the gesture/lifetime invariant by invoking `permissions.request()` first and retaining its promise, immediately dispatching `armCleanupApproval` without awaiting it in the same synchronous activation, and making the permission promise the first await. Arm validation uses the already bound context plus a constant-time capability check and does not race popup teardown with a new live-context lookup.
- Independently audit the frozen remediation with no concrete P0/P1 finding: 163/163 focused checks pass (`8+35+14+1+33+42+25+5`), plus cleanup-mode/download checks at 10/10. The syntax scan passes across 433 files, and types, ESLint, Prettier, and diff checks pass. One isolated timing case reproduced only under concurrent runner contention, then passed in the 42/42 suite rerun and 10/10 exact-case rerun; it is classified as non-product harness contention. The complete validation/evidence transaction and exact-artifact SiteWipe 1.11.40 installed validation remain pending; the installed matrix must repeat preparation with an absent sender document ID, detailed/direct permission settlement, popup destruction/restart, cross-context no-transfer/reconciliation, terminal replay, incognito, lookalike, report, temporary-access release, and downloaded-file preservation.

## 1.11.39 — public-source prerelease work — 2026-08-21

### Worker-owned optional-host-permission handoff — source verified; installed validation pending

- Record the exact installed SiteWipe 1.11.38 Standard failure: Chrome accepted the four reviewed `example.com` host patterns, but the native prompt destroyed the popup continuation before it submitted cleanup. No cleanup job, report, request shield, or fixture mutation occurred; the temporary grant was later removed. A subsequently expired review remained actionable in the popup, and the worker correctly rejected it without mutation.
- Move missing-host-access continuation into a preflight-bound, worker-owned handoff. The 1.11.39 final SiteWipe action invokes `permissions.request()` first and retains its promise, immediately dispatches the arm message without awaiting it before the first `await`, and makes the permission promise the first awaited, gesture-gated browser call. A worker-generated nonce, the then-intended `sender.documentId` popup binding, complete approval/context binding, repeated exact-grant proof, and no-retry admission boundary were designed to prevent popup destruction, partial/broad/manual grants, and duplicate wake-ups from creating authority; the Unreleased entry records the installed document-identity defect and replacement design.
- Treat `permissions.onAdded` only as a wake signal. Only an unexpired `armed` handoff can resume, while expiry, settings changes, reset, or other invalidation creates a non-runnable prompt tombstone until exact settlement or a real browser-session boundary. Private-source cleanup still requires browser-controlled incognito access plus pre-existing exact target access, and downloaded-file deletion remains governed by its existing setting and preflight-bound file evidence.
- Independently source-verify the frozen runtime with no concrete P0/P1 finding: routing 31/31, startup 42/42, focused handoff security 104/104, popup 22/22, and preflight/review/lease 57/57 pass. The full unit run reaches 486/487 with only the expected pre-version-bump fingerprint mismatch; types, lint, format, documentation, and the remaining static checks pass.
- Keep installed validation open: the next versioned exact artifact must repeat detailed and direct Standard/Expert prompt grant, denial, expiry, popup-destruction, worker-restart, race, incognito, lookalike, report, temporary-access-release, and downloaded-file-preservation checks before publication evidence can pass. Source verification does not convert the failed installed 1.11.38 run into a pass.

## 1.11.38 — public-source prerelease work — 2026-08-21

### Final source-ledger normalization

- Fingerprint the fully formatted evergreen readiness and owner-review tables after the current-version evidence reset clarification.

## 1.11.37 — public-source prerelease work — 2026-08-21

### Candidate-evidence reset truth

- Keep Chrome and provenance readiness rows version-agnostic after a version transaction, and archive the exact 1.11.35 automated/browser records instead of allowing a new candidate to inherit them.

## 1.11.36 — public-source prerelease work — 2026-08-21

### Publication-status truth and review ownership

- Replace transient pass/pending statements in release, testing, safety, claim, and owner-review documents with durable pointers to the active machine-readable evidence.
- Distinguish an already-authorized public candidate-branch source push from the still-unapproved merge, tag, GitHub Release, browser-store, and professional-profile actions.
- Record that `@NouraldinFarge` is the owner/maintainer while a distinct independent reviewer remains required, and correct draft/public-source and mode-specific downloaded-file wording.

## 1.11.35 — public-source prerelease work — 2026-08-21

### Installed full-report opening

- Open the full-report side panel from the popup's live user gesture while preserving the exact report-ID binding, preventing Chrome from rejecting the completed-report action after an asynchronous background hop.

## 1.11.34 — public-source prerelease work — 2026-08-20

### Service-worker startup and request-shield recovery

- Make the first detailed-review or direct-cleanup action wait for bounded startup recovery instead of failing on a transient service-worker maintenance reservation.
- Keep failed or uncertain job, request-shield, cleanup-review, permission-lease, update-migration, and administrative recovery state fail-closed until a fresh safety proof succeeds.
- Persist a browser-session-bound DNR mutation marker before every SiteWipe-owned rule change. Partial writes, worker loss, unresolved callbacks, and same-session recovery remain quarantined until a verified browser-session boundary and an empty owned-rule range are proved.
- Prevent uncertain request-shield installation and removal operations from overlapping, and require successful removal plus available, error-free, empty-range diagnostics before clearing recovery state.
- Keep Standard and Expert direct cleanup pending through one bounded startup retry without moving the native host-permission request outside the final user activation.

## 1.11.33 — public-source prerelease work — 2026-08-20

### Approval and publication-claim alignment

- Align the README, safety case, claim registry, historical remote plan, owner packet, privacy-flow wording, and generated release notes with the approved monotonic public-candidate version and the restored anonymous repository access.

## 1.11.32 — public-source prerelease work — 2026-08-20

### Publication ledger normalization

- Normalize the updated public-repository readiness and owner-review tables before freezing the candidate, preserving the exact stable-input fingerprint contract.

## 1.11.31 — public-source prerelease work — 2026-08-20

### Public repository truth

- Replace obsolete account-restoration and anonymous-404 language after independently confirming the repository is publicly reachable.
- Record the closed, unmerged 1.11.29 draft and keep the selected replacement candidate distinct from tags, binary releases, store submission, and professional-profile approval.

## 1.11.30 — public-source prerelease work — 2026-08-20

### Public-candidate version alignment

- Retire the unmerged 1.11.29 draft and advance the owner-selected current SiteWipe codebase to the next monotonic public-candidate version without importing the discarded draft branch.

## 1.11.17 — public-source prerelease work — 2026-08-20

### History residue wording

- Distinguish a valid numeric residue count from residue evidence whose count is missing or invalid. History now reports uncounted evidence explicitly and never contradicts itself by calling it both unknown and known residue.

## 1.11.16 — public-source prerelease work — 2026-08-20

### Fail-closed report outcome consistency

- Prevent contradictory verification evidence from being presented as a green verified-zero result. Any explicit residue claim, invalid or mismatched category count, missing required category, incomplete check, or disagreement with the summary now remains residue/incomplete with unknown totals as appropriate.
- Preserve the most conservative runtime-error and unavailable-limit counts across retained summary totals and detailed arrays in the side panel, history, troubleshooting view, and text/HTML exports.

## 1.11.15 — public-source prerelease work — 2026-08-20

### Cross-state UI safety and report truth

- Bind popup report actions to the exact displayed persisted report. Private or otherwise transient reports now stay popup-only, hide stored-report actions, and cannot open or forget an older local report.
- Keep detailed-review permission failures visible and assertively announced inside the review, relabel the approval action as an explicit retry, and restore focus to that retry action without starting cleanup.
- Keep every Options control natively disabled until the complete authoritative settings, private-access, and optional-permission state has loaded. A failed load now presents a locked recovery panel, and a successful retry hydrates settings before enabling applicable controls.
- Classify side-panel outcomes from both runtime status and post-clean verification evidence. Verified zero is the only green result; known residue, incomplete checks, unknown totals, and runtime errors stay distinct in the report, exports, and history aggregation.
- Add deterministic ChatGPT in-app Browser fixture states for transient private reports, permission denial/retry, fail-once Options hydration, verified zero, residue with unknown totals, incomplete verification, runtime errors, and mixed history.

## 1.11.14 — public-source prerelease work — 2026-08-20

### Direct-cleanup wording

- Clarify that the saved direct-cleanup preference starts the **current target** from one SiteWipe popup action in either Standard or Expert mode; browser-controlled permission confirmation can still appear.

## 1.11.13 — public-source prerelease work — 2026-08-20

### Interface clarity and responsive behavior

- Rework the popup around one clear scroll surface and explicit preparation, review, progress, and result states. Direct cleanup keeps **Clean now** prominent; detailed review restores heading focus and readable sticky approval controls; completed cleanup foregrounds a fully reachable result with **Open full report** and **Clean another site** instead of compressing the report beneath the target form.
- Keep popup target presentation privacy-minimized by showing the canonical site identity needed for scope while explaining that URL paths, queries, credentials, and fragments are ignored without rendering those discarded details. Improve unsupported-tab guidance and preserve usable detailed review at the packaged 380-pixel width and narrow synthetic zoom fixtures.
- Reorganize Options into keyboard-reachable sections with skip navigation, responsive section chips, progressively disclosed advanced/report/live-page controls, concise saved-mode/direct/private/job feedback, and clearer high-impact and danger areas without changing cleanup authorization or permission semantics.
- Restructure the side panel into responsive report groups and filters; distinguish runtime errors, intentional skips, and browser-unavailable limits; make privacy-safer redacted exports primary while placing full stored-detail export behind an explicit sensitive-data disclosure; and clarify history empty states and destructive actions.
- Align the manifest summary with both the ordinary detailed-review path and the explicitly enabled saved direct-cleanup setting without implying that saved authorization removes native browser prompts or internal preflight safeguards.

### Runtime and reporting correctness

- Treat Chrome's `tabs.SPLIT_VIEW_ID_NONE` value of `-1` as the absence of split view so ordinary tabs do not inflate split-view residue counts.
- Classify a tab that disappears during progress-overlay live revalidation as an expected skip rather than an injection failure, avoiding a false warning when SiteWipe or the user has already closed the tab.
- Finish cleanup phase timing before the short presentation-only 100% progress dwell so reported work durations exclude deliberate UI display time.

### Synthetic UI validation

- Extend the loopback fixture server and source contracts to exercise the real popup, Options page, and side panel with synthetic browser-API mocks, including direct/detailed popup states, narrow layouts, grouped reports, filters, history states, and privacy export presentation.
- Keep ChatGPT in-app Browser observations explicitly classified as synthetic HTTP UI evidence: they can support layout, semantics, keyboard flow, focus, responsive behavior, and copy review, but not installed Chrome/Brave, exact-artifact, incognito, native-prompt, MV3 lifecycle, privileged cleanup, performance, or authentic store-media claims.

## 1.11.12 — public-source prerelease work — 2026-08-20

### Opt-in direct cleanup

- Add the default-off **Skip detailed cleanup review completely** setting for Standard and Expert mode. Enabling it requires an explicit Settings warning covering current destructive, file, associated/protected, private-window, and native permission-prompt effects.
- Prepare the complete read-only target/settings/context/private/access/impact/file-ID snapshot and durable `prompt_pending` permission lease before **Clean now** becomes actionable, then use one SiteWipe popup activation to request any missing normal-window exact access and submit a short-lived, single-use `settings_direct` authorization. A native Chrome/Brave prompt may still require a separate browser-controlled confirmation.
- Keep private-source direct cleanup conditional on browser-controlled **Allow in incognito** and pre-existing exact target access; do not request or persist missing private target patterns under the current lease policy.
- Keep Expert downloaded-file candidates preflight-ID-bound and immediately live-revalidated while intentionally skipping the per-run typed file phrase under saved direct authorization.
- Report direct authorization truthfully with `cleanupApprovalMode: settings_direct`, `scopeReviewApproved: false`, saved-direct authorization evidence, and a separate preflight-bound file count. No caller skip flag, raw cleanup route, synthetic acknowledgement, or legacy quick/bypass mode is accepted.
- Add ADR 0011 and the owner's explicit design decision while preserving ADR 0004 and its false approval record as historical. Replace the publication gate's former blanket bypass prohibition with checks for default-off policy, explicit confirmation, preflight/mode/file/lease binding, prompt ordering/recovery, truthful reporting, and consumption of the ordinary single-use cleanup route.

## 1.11.11 — public-source prerelease work — 2026-08-20

### Validation reconciliation

- Keep the legacy Expert-mode self-test consistent with the enforced progress-overlay parent dependency while retaining the review-bypass rejection assertion.

## 1.11.10 — public-source prerelease work — 2026-08-20

### Installed-review reproducibility

- Lock the user-recorded Expert/private/protected Reddit review shape through session serialization and final approval, including its canonical stored target plus preserved broad HTTP/HTTPS grants.
- Compare stored host-permission inventory dictionaries independently of object-key order while preserving array order and derived-field tamper checks, preventing Chromium storage deserialization from falsely rejecting an unchanged approval.
- Require installed testing to use a frozen candidate tree and an explicit extension reload after source changes so a popup and service worker from different live-unpacked source states cannot be mistaken for one exact-version result.
- Stack the Options prerelease warning only when its content column is constrained, keeping the wide layout compact while preventing its explanation from collapsing into a narrow side column.
- Let the popup's active-tab explanation wrap to three lines so unsupported-page guidance remains visible without allowing long tab details to dominate the card.

## 1.11.9 — public-source prerelease work — 2026-08-20

### Popup readability

- Stack the prerelease warning into a full-width heading and description, wrap both safely, and suppress horizontal shell scrolling after user-supplied installed-Chrome screenshots exposed the cramped two-column notice and bottom scrollbar.

## 1.11.8 — public-source prerelease work — 2026-08-20

### Popup sizing

- Restore a definite 380-pixel intrinsic popup width so Chrome cannot collapse the extension action into a narrow vertical strip; keep 200%/400% reflow testing isolated to an explicit synthetic fixture width instead of changing the packaged popup's sizing contract.

## 1.11.7 — public-source prerelease work — 2026-08-20

### Synthetic Browser styling and reflow

- Permit same-origin stylesheets in the fixture CSP so the ChatGPT in-app Browser exercises the popup's real packaged styling instead of an unstyled shell.
- Remove intrinsic-width overflow from long reviewed URLs, permission patterns, list items, and effect values so the complete approval screen reflows at the synthetic 200% and 400% accessibility fixtures.

## 1.11.6 — public-source prerelease work — 2026-08-20

### Synthetic Browser fixture integrity

- Serve and regression-check the popup's complete strict source-window import chain so the ChatGPT in-app Browser fixture cannot render a controller-less shell after a source change.

## 1.11.5 — public-source prerelease work — 2026-08-20

### Cleanup authorization and consent

- Revalidate current effective settings, normalized/associated target scope, and browser private-access state when a single-use review token is consumed; invalidate displayed reviews after settings changes; and reject every stale mismatch before permission-lease activation, job creation, request shielding, or browser-data mutation.
- Advance the cleanup-review schema and bind the complete normalized impact and displayed-review snapshot—including counts, limitations, exact required/temporary site-access patterns, acknowledgements, and approved file IDs—so tampering or older incomplete records fail closed.
- Display the active Standard/Expert mode and exact target site-access patterns in every cleanup review. Both modes continue to require a distinct final approval; no one-action, quick, or review-skipping cleanup path exists.
- Bind the progress overlay's enabled state, target/current-window/all-tabs reach, reviewed source window, cancel control, shared 120-tab ceiling, unrelated-page warning, and cleanup watchdog into the mandatory review snapshot; live-revalidate cached tabs before messaging or injection and again after receiver loss so navigation, private-scope, restricted-page, or window changes fail closed.

### Private scope, irreversible files, and lifecycle truthfulness

- Carry immutable reviewed private-window authority through discovery, page injection, progress overlays, tab-state changes, tab closure, and verification; revalidate live tabs against both target and private scope; and require target access before a private-source preflight so no missing/temporary private pattern enters durable permission-lease state.
- Fail closed when the popup's source-window identity or private state cannot be proven, and independently inspect that exact window in the service worker before review/lease creation and again after single-use approval consumption.
- Re-query each approved downloaded-file candidate immediately before irreversible removal and require one exact live record with unchanged target, approval, completion/existence, filename, URL, final URL, and referrer; preserve the file and download record whenever identity or outcome is uncertain.
- Retain DNR recovery while an originally timed-out rule install remains pending, treating an interim empty range as provisional; track the pending call in memory and durable state, block a new cleanup from reusing the owned range until settlement and reconciliation, and scope late settlement to the originating job. Tab-removal timeouts remain unknown, and cancellation state cannot cross replacement job identities.
- Skip shared DNR request shielding entirely for a normal-only reviewed cleanup so a later private-access change cannot affect private target traffic; track timed-out clears as well as installs and refuse newer shield reuse until every older rule mutation settles.
- Persist reports according to the privacy settings approved for that run, preventing a later settings change from silently enabling unredacted or history retention, and classify cancellation only from explicit `AbortError` evidence.
- Limit post-grant popup rollback to patterns classified temporary by that preflight and only when no cleanup job is proved to have begun; preserve access and surface manual review on ambiguous outcomes.
- Inventory and bind a privacy-minimized subset of currently granted host patterns at preflight, distinguish exact required grants from relevant broader/all-site pre-existing access, omit unrelated hostnames, display that access separately, report it truthfully, and guarantee broader user-controlled grants never enter automatic removal calls.
- Reject settings, reset, request-shield, manual-maintenance, and local-reset actions during a live cleanup; mirror the guard with disabled/ARIA-explained Options controls; and keep Expert embedded-frame discovery plus `webNavigation` persistently off in Standard, on initial Expert entry, on disable, and on reset until a later explicit gesture enables it.
- Reserve the cleanup lifecycle synchronously at handler admission so cleanup/review startup cannot overlap an admitted administrative mutation or install/startup/alarm recovery, and no administrative action can enter during the pre-job cleanup interval. Coalesce deferred maintenance for replay after the reservation ends, while preserving read-only status and active-job cancellation access and identity-checking stale-job recovery before it writes.
- Replace permissive settings import with a size-bounded, SiteWipe schema/app/version-checked, allowlisted, value-validated backup format and a complete change/risk confirmation before the single background save.

### Documentation and evidence boundaries

- Replace a stale installed-browser checklist that still described the retired cleanup-review bypass with mandatory-review, freshness, tamper, private-scope, grant-recovery, file-identity, and late-outcome cases.
- Add a dated 2026-08-20 first-party Chrome permission/policy source ledger and reconcile the architecture, permission matrix, threat model, privacy flow, safety case, issue register, claim ledger, and release checklist.
- Separate ChatGPT in-app Browser synthetic UI evidence from installed Chrome/Brave extension evidence; native prompts, incognito, MV3 lifecycle, privileged APIs, exact-artifact compatibility, accessibility, and performance remain pending until retained disposable-profile runs exist.
- Make the publication gate rerun reusable version/source and exact runtime/source artifact verification in-process instead of trusting command order; require the reviewed dependency-inventory hash to match the exact pre-bump lockfile before rebinding; validate direct development name/version/license tuples; and invalidate coverage, install, audit, fixture, build, synthetic-browser, and technical-provenance results for every new candidate. The fresh 2026-08-20 automated record starts pending and does not overwrite the historical 2026-08-17 result.

## 1.11.4 — public-source prerelease work — 2026-08-17

### Local check isolation

- Aligned ESLint's ignore boundary with the repository's generated browser-profile, coverage, artifact, Playwright-report, test-result, dependency, and third-party paths so local quality gates inspect the candidate source instead of disposable test data.

## 1.11.3 — public-source prerelease work — 2026-08-17

### Repository truth and build provenance

- Reconciled the `1.11.2` default-branch baseline with the owner-visible public repository while explicitly preserving the current anonymous `404`, unreleased-binary status, and the separate unmerged `1.11.29` draft candidate.
- Renamed private-staging package, artifact, CI, and manual-environment labels to unreleased-candidate terminology; linked GitHub Private Vulnerability Reporting from issue/security surfaces; and recorded the read-only repository settings audit without treating unavailable public access as success.
- Made CI and CodeQL check out and assert the exact pull-request head or event commit, renamed the duplicate report-redaction decision to ADR 0010, and kept the broad 17-gate prerelease work out of this main-compatible hotfix.
- Switched the complete source ZIP to sorted stored entries with fixed timestamps/modes so its archive bytes have a cross-platform reproducibility contract, while limiting the compressed runtime ZIP claim to exact extracted parity and recorded same-environment comparisons until a two-host check exists.
- Bound browser, performance, accessibility, media, SBOM, and unsigned-provenance evidence names to each version transaction so prior candidate evidence cannot silently follow new bytes.

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
- Extended version enforcement from runtime-only fingerprinting to every stable release input—including scripts, CI, tests, documentation, assets, configuration, lockfile, and third-party material—while excluding mutable post-build evidence and owner-approval records to avoid circular artifact invalidation.

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
