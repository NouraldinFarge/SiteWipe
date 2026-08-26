# Changelog

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

This log distinguishes private engineering candidates from public releases. No version listed here has been published as an approved public release.

## Unreleased

## 1.11.98 — public-source prerelease work — 2026-08-25

### Forward 1.11.98 exact validation-protocol correction

- Preserve exact local 1.11.97 as complete-check history. Its guarded transaction bound runtime fingerprint `6100275EAF1021C61B01871BCCBB43D1C5A65AAC61966FC4E2CC24AC94B87FA7` and 310-input stable-release fingerprint `27DEAEC49B04239C5989D2B8E856179E56D3CD117F81BDE9FE1E49D6747A66E7` under Node.js `v24.18.1` and npm `11.16.0`; its finalized dated automated record has pre-successor SHA-256 `BA1AB777E8BE7AEFFDBF90E3FAD1CE8962EAEDED40359F226C313EE82FA89B0F`.
- Record that exact 1.11.97 passed every safeguard in `npm run check`: 1,402 of 1,405 unit tests passed with zero failures and three explicit platform-inapplicable skips in `486086.3038ms`, and the property stage passed 11/11 in `254.7893ms`.
- Record the required 1.11.97 coverage command as intentionally interrupted with no valid result after the late SW-094 audit found divergent clean-install and dependency-audit commands, a false separate-CI-property-step claim, and workflow timeouts that could not contain the required sequence. Its partial threshold output is neither a pass nor a failure.
- Make the exact release protocol canonical everywhere as `npm ci --ignore-scripts --no-audit --no-fund`, complete checks, coverage, and `npm audit --audit-level=low --json`; require their exact fields in publication evidence; reset stale commands rather than preserving them; use the pinned release toolchain; and give CI and the protected candidate job bounded 45- and 60-minute budgets.
- Bind the remote collector's sealed GitHub REST API version to the exact request header, and wire the protected workflow to independently supplied expected-binding and read-only-token inputs plus a fresh external capture. A bounded GET-only preflight proves the exact variable value and secret-name metadata exist under the literal protected environment and trusted repository identity before create-only staging, so same-named repository/organization fallbacks fail closed. Remote APIs still cannot prove reviewer availability or actual independent review, and no workflow may self-attest those human facts.
- Clean reinstall/audit, the separate 48-test accessibility source run, artifacts, installed browsers, performance, media, independent review, commit, push, remote capture, and publication evaluation did not run for exact 1.11.97. The forward correction changes validation documentation, tooling, workflows, evidence contracts, and necessary exact-candidate bindings only; at the 1.11.98 stable-input seal boundary no 1.11.98 result exists.

## 1.11.97 — public-source prerelease work — 2026-08-25

### Forward 1.11.97 evidence-location truth correction

- Preserve exact local 1.11.96 as complete-check history. Its guarded transaction bound runtime fingerprint `F966D8047F989939249F78A6FAAA2ADD3494F87A84C7B458F2A1E1094A72C6AE` and 310-input stable-release fingerprint `44E46FC200741021719DCEE9783A362D1E0500712277F8CA018368650594C217` under Node.js `v24.18.1` and npm `11.16.0`; the finalized dated automated record has independently captured pre-successor SHA-256 `F61DEF700144BD4076A27E4EB498A27538971752F56825892D6DCCF287A2EF67`.
- Record that its complete command passed every source safeguard, 1,402 of 1,405 unit tests with zero failures and three explicit platform-inapplicable skips, and 11/11 property tests. Coverage and every later stage did not run because the post-check audit found SW-093 before the long coverage run.
- Correct the one current-facing readiness sentence that placed exact 1.11.95 results in active evidence even though the active pointer selected 1.11.96. Historical results belong to their immutable dated records; exact current status belongs to the dated record selected by the active pointer.
- Make issue-register status cells version-neutral so completed historical repairs do not read as still-staged successor work. The forward correction changes stable documentation and necessary exact-candidate bindings only; extension cleanup, permission, data-scope, downloaded-file, storage, and messaging behavior are unchanged.
- At the 1.11.97 stable-input seal boundary no 1.11.97 validation result exists. Installed-browser, artifact, accessibility, performance, media, reviewer, remote, and publication gates remain separate.

## 1.11.96 — public-source prerelease work — 2026-08-25

### Forward 1.11.96 stable release-stage correction

- Preserve exact local 1.11.95 as successful local-check history. Its guarded transaction bound runtime fingerprint `7A7433CB3545D507901121729A9712E505356BB9517A0F2AD195A76D50BA8463` and 310-input stable-release fingerprint `C10D314E0E01C3E8ECB14A83A82F5E9E71215132EB8EC9D10A7AF57465759334` under Node.js `v24.18.1` and npm `11.16.0`.
- Record that the complete check finished 1,405 tests with 1,402 passed, zero failed, and three explicit platform skips; the separate property run passed 11/11; required coverage passed 1,402 of 1,405 with the same three skips at 86.86% statements, 76.32% branches, 93.70% functions, and 86.86% lines; the clean locked install and explicit low-threshold audit found zero vulnerabilities; and the focused accessibility source-contract run passed 48/48.
- Stage SW-092 after the post-validation truth audit found non-temporal stable prose that still read as a live “validation remains unrun” claim, release instructions that omitted the required repeated-reproducibility command and clean evidence-commit boundaries, and a false statement that build scripts write tracked evidence. The forward correction changes stable release documentation and necessary exact-candidate version bindings only; extension runtime, cleanup, permission, data-scope, downloaded-file, storage, and messaging behavior are unchanged.
- Exact 1.11.95 remains uncommitted and unbuilt. At the 1.11.96 stable-input seal boundary, no 1.11.96 validation exists yet; exact current status belongs only to the active candidate-scoped evidence records, and installed-browser, artifact, reviewer, remote, and publication gates remain separate.

## 1.11.95 — public-source prerelease work — 2026-08-25

### Forward 1.11.95 exact-candidate decision binding

- Preserve exact local 1.11.94 as failed unit-test history. Its guarded transaction succeeded with runtime fingerprint `0EE478F2485E8615B7C07B1E6310D0383A59E945E021071F15A404D9341C2A7A` and 310-input stable-release fingerprint `B27F39A1752CC032F5B34B0CAACAF1E6570322E655623E9D6170D313E6417BAE` under Node.js `v24.18.1` and npm `11.16.0`.
- Record that its first `npm run check` attempt passed formatting, exact version, the 217-file syntax scan, types, lint, HTML, CSS, manifest, remote-code, secret scanning across 414 files, the development SBOM at 358 components and 417 dependency nodes, dependency licenses for 416 packages, project license, notices, assets, documentation across 49 files, 10 action pins, the 61-plus-3 package allowlists, and the legacy self-test. The unit suite then completed 1,405 tests with 1,401 passed, one failed, and three platform skips in `540992.2203ms`.
- Stage SW-091 as the minimum forward-only 1.11.95 correction. The sole failure was the exact-current owner-amended Direct Cleanup contract because mutable `reviewedVersion` remained `1.11.93`; the corrective source advances that field, the product identity's `approvedPublicVersion`, the remote decision's `approvedPublicCandidateVersion`, and the remote branch to exact candidate `1.11.95` while preserving every owner statement and invariant.
- Property testing, coverage, dependency reinstall/audit, artifact creation, installed-browser validation, commit, push, remote validation, and publication did not run for 1.11.94. At the time the 1.11.95 stable inputs were sealed, complete 1.11.95 validation had not yet run, and this correction creates no installed result, artifact result, reviewer approval, publication result, or supported-binary claim.

## 1.11.94 — public-source prerelease work — 2026-08-25

### Forward 1.11.94 synthetic-path secret-scan correction

- Preserve exact local 1.11.93 as failed-at-secrets history. Its guarded transaction succeeded with runtime fingerprint `7884F251F8FD56D7EC4A8676DCF0FC4BC9790BD46FF56837A1013EF8A123334B` and 310-input stable-release fingerprint `0FBF99145E648F862F72AA834DC075B2ED12B34776B4EBEC7BA5F2D7CBD97205`. Its first `npm run check` attempt passed formatting, the exact version contract, the 217-file syntax scan, types, lint, HTML, CSS, manifest, and remote-code checks, then `check:secrets` stopped on synthetic absolute private-home-path literals in `tests/browser/installed/semantic-validator.test.mjs`. No later safeguards, tests, property run, coverage, artifact, browser run, commit, push, remote validation, or publication action occurred.
- Stage SW-090 as a minimal test-only correction: construct the same validator-rejected synthetic Windows path and private file-URL values from non-private source fragments so the stable source contains no private-path literal while preserving the negative semantic-validator cases.
- Focused validation passed the semantic-validator suite at 9/9, `check:secrets` across 413 source-archive files, and scoped Prettier and ESLint. Complete 1.11.94 validation remains unrun.
- SW-090 changes no extension runtime, cleanup or permission behavior, owner quotation, approval, installed result, artifact result, reviewer result, or supported-binary claim.

## 1.11.93 — public-source prerelease work — 2026-08-25

### Forward 1.11.93 validation-integrity corrections

- Preserve exact local 1.11.92 as failed-at-lint history. Its version transaction succeeded with runtime fingerprint `8084015525025E824CE600D25553A28493BD5D7743B29103F007CCCD3A0F443F` and 305-input stable-release fingerprint `067AD9F681D349B810D7B0E2CA9BB68E5690322160ACD8F7DA347FF328598A31`. Its first `npm run check` attempt passed formatting, the version contract, the 212-file syntax scan, and types, then stopped on two installed-runner `no-unsafe-finally` lint errors. No later tests, coverage, build, browser run, commit, push, or publication action occurred.
- Stage SW-082 by recording central-cleanup errors in an explicit `cleanupFailure` value and folding that value into the existing failure path after `finally`, instead of throwing from `finally`.
- Stage the separate SW-083 transaction-planning repair by binding the exact current dated validation record path and bytes once as a read-only transaction input captured and replayed under the lock. The transaction does not re-resolve the active pointer after capture or include mutable evidence in stable fingerprints. Its regression mutates the record after capture and proves refusal before the version, pointer, or successor record changes; explicit recovery leaves that dated record untouched.
- Stage SW-084 by deriving browser, semantic-receipt, accessibility, performance, and media records only from the exact frozen final disk replay; caller objects must canonically equal those final records, and the successful validator returns only deeply frozen final-pass records and inventory.
- Stage SW-085 by making the publication checker consume one verified-commit source snapshot, use only the release verifier's runtime ZIP digest, require automated finalization entries to be either absent as a pair or exactly one committed pointer plus its active committed dated target, bind every finalization entry to committed bytes, and repeat exact release/source/head/tree/worktree verification at the terminal boundary.
- Stage SW-086 by capturing `dist/current` once with exact physical file identities and privately owned bytes, validating all release metadata and ZIP content from that snapshot, replaying the complete directory twice, and running the reusable version contract from the already captured committed Git blobs and runtime ZIP bytes.
- Stage SW-087 by requiring exact current-version media role paths, an exact referenced-media/finalization-entry set, byte counts, SHA-256 digests, parsed PNG dimensions and scanlines, and a narrow coherent sampled AVC-in-MP4 profile. The parser deliberately does not claim decoding, playback, rendered dimensions, or visible authenticity; those remain blocked on actual human playback review and explicit media reviewer approval.
- Stage SW-088 by requiring the committed finalization-manifest bytes themselves to be canonical and to equal both the final replay's manifest digest and canonical returned manifest. A temporary canonical substitute can no longer be restored to different clean committed bytes before terminal replay.
- Stage SW-089 by binding the active automated-evidence pointer version, any version-qualified filename, the record's version-contract and manifest versions, and every optional top-level candidate-version field to the exact package version, including when the pointer/target pair is absent from finalization entries.
- Focused validation passed the transaction suite at 34 total/33 passed/1 platform skip, the validation-evidence transition at 1/1, the installed-runner suite at 18/18, the 63/63 non-media release-integrity audit, the 118/118 media-contract suite, the then-current 1.11.93 syntax scan, types, lint, formatting, documentation, JSON, owner-statement, and diff checks. These scoped results do not establish a complete 1.11.93 check, coverage, artifact, installed-browser result, commit, push, or publication approval.
- SW-082 through SW-089 preserve the SW-080/SW-081 browser-lifecycle, bootstrap, closure, transaction, and immutable-finalization design while repairing validation and publication-evidence integrity. Extension cleanup authority, permissions, private access, browser-data scope, downloaded-file behavior, storage, messaging, human-review requirements, and the absent finalization manifest remain unchanged.

## 1.11.92 — public-source prerelease work — 2026-08-25

### Forward 1.11.92 installed-validation and publication-integrity repair

- Preserve exact local 1.11.91 as superseded before complete validation. Its version contract, documentation, dependency-license, and focused safety-contract audits passed, but a later adversarial review found eight ways the new unattended harness could publish or retain evidence more strongly than the underlying browser observation justified. No complete check, coverage run, artifact, browser run, commit, push, or remote validation was completed for 1.11.91.
- Centrally authenticate every direct or fallback browser-close receipt and make uncertain closure non-passing; make terminal settlement explicit and durable before its one-shot capability is consumed; bind workspace markers and coordinator outputs to exact identity and post-write bytes; cap and cancel the exact spawned native helper; and keep public CLI refusals path-free.
- Replace provisional SMOKE and SETTINGS safety claims with authentic, nonempty, before/after browser observations. SMOKE seeds the exact bounded fixture and compares deep inventories and value digests while leaving the unobserved real side-panel surface `not_run`; SETTINGS observes the exact extension document and independently inventories cleanup authority, permissions, rules, incognito state, browser download records, and the owned synthetic download directory before emitting evidence. Missing, ambiguous, unsupported, or incompletely closed observations remain non-passing.
- Record the separate SW-081 follow-up repair before the source freeze: own one direct browser spawn and one central bounded close, remove raw close/disconnect authority from scenario hooks, bound every lifecycle phase, and permit exact identity-checked fallback tree termination only for the owned process followed by a second zero-residue observation. Bind browser-runtime and source-directory closure with two complete BigInt identity/byte walks; bootstrap the verified installed runtime through built-in strict ZIP inspection and exact import closure; make ordinary version-bump startup refuse every retained transaction state while explicit recovery requires the original exact sorted target/operation allowlist; and make the fixed evidence-finalization manifest immutable, disk-canonical, and subject to two complete inventory replays. These controls are staged source and still require exact 1.11.92 complete validation.
- This transaction strengthens validation and evidence integrity only. It does not broaden extension cleanup authority, permission scope, private access, browser-data scope, downloaded-file behavior, storage behavior, or messaging, and it does not create independent review, installed-browser completion, a supported binary, or publication approval.

## 1.11.91 — public-source prerelease work — 2026-08-25

### Forward 1.11.91 canonical-format closure

- Preserve exact local 1.11.90 as failed post-transaction history. Its first complete-check attempt stopped at the format gate because six new validation/tooling files were not yet in canonical Prettier form; after those exact files were formatted, the second attempt correctly stopped at the version contract because their stable-input bytes no longer matched the sealed 1.11.90 fingerprint.
- Carry only those mechanical formatting corrections and truthful version/evidence records into 1.11.91. The installed-browser runtime/toolchain closure, owned execution, semantic replay, authenticated remote evidence, failure settlement, and evidence-finalization behavior are otherwise unchanged, as are all extension cleanup logic, permission authority, data scope, downloaded-file behavior, storage, and messaging.

## 1.11.90 — public-source prerelease work — 2026-08-25

### Forward 1.11.90 installed-browser evidence-integrity closure

- Preserve exact 1.11.89 at draft PR #12 as immutable source-candidate history. Its local complete check, required coverage, strict packaging, repeated reproducibility, and exact-head CI and CodeQL passed at `6965c324f1bdec57361fc9664976f7022e86df03`; those results do not establish installed Chrome/Brave behavior, independent review, a supported binary, or any later publication stage.
- Bind unattended installed-browser work to the clean committed source and tree, canonical artifact, full browser-runtime closures, trusted Git/Node/PowerShell/helper identities, exact lockfile and installed Puppeteer closure, fixed non-maximized geometry, fresh owned profiles, dual-stack loopback fixtures, a deny-by-default proxy, one-shot process ownership, and retained fail-closed settlement. Unexpected orchestration failure retains the exact owned run and releases only its identity-bound active lock; it never recursively deletes profiles, evidence, or downloaded files.
- Add assertion-specific typed semantic replay, path-free public receipts, an authenticated read-only GitHub raw-response collector, and an exact allowlisted evidence-finalization contract. Missing validators, unsupported browser behavior, ambiguous native UI, absent evidence, failed assertions, and incomplete teardown remain non-passing; automation cannot set reviewer approval or manufacture a supported-binary claim.
- Stage authentic executor coverage incrementally, beginning with exact-artifact/fresh-install surfaces and the complete visible/internal Settings inventory. The canonical 24-scenario × two-browser matrix remains the authority, and every unimplemented or unobserved assertion stays explicitly `not_run`. This transaction changes installed-validation and publication-evidence tooling, not extension cleanup authority, permission scope, browser-data behavior, downloaded-file behavior, storage, or messaging.

## 1.11.89 — public-source prerelease work — 2026-08-25

### Forward 1.11.89 installed-browser path-contract parity repair

- Preserve exact 1.11.88 at draft PR #11 as failed remote history. Exact-head CodeQL passed, while exact-head CI stopped at 947/951 after Linux applied host-native absolute-path checks to serialized Windows installed-browser paths; the hosted CI property, coverage, and reproducibility steps were skipped.
- Validate serialized browser-plan paths with a host-independent local grammar that accepts only single-root POSIX paths or explicit drive-qualified Windows paths. Reject relative, drive-relative, root-relative, UNC/network, device-namespace, whitespace-padded, and NUL-containing forms, and reject a foreign path before any native physical lookup.
- Keep physical file access bound to the current host before resolving or hashing directories, artifacts, helpers, and pinned executables. The substantive repair changes only installed-browser harness and evidence-path validation plus regression coverage. The required version transaction also changes version-bearing runtime metadata and resets candidate-sensitive evidence, but it does not change cleanup logic or authority, permissions, browser-data scope, downloaded-file behavior, storage, or messaging.

## 1.11.88 — public-source prerelease work — 2026-08-25

### Forward 1.11.88 toolchain and release-truth correction

- Preserve exact local 1.11.87 as superseded before clean installation, complete validation, coverage, build, commit, push, or publication. Its post-bump audit found both a false byte-exact claim about unchanged runtime files and a newer compatible Node security release.
- Pin both GitHub workflows to Node 24.18.1, whose bundled npm 11.16.0 preserves the development-SBOM tool version needed for exact local/remote byte parity while incorporating the July 2026 Node security fixes. Require fresh exact-head CI and CodeQL to prove the resulting candidate.
- State the scope precisely: the substantive repair changes only remote workflow toolchain selection. The required forward version transaction also changes version-bearing runtime metadata and resets candidate-sensitive evidence, but it changes no cleanup logic, permission authority, data scope, downloaded-file behavior, storage behavior, or messaging contract.

## 1.11.87 — public-source prerelease work — 2026-08-25

### Deterministic CI toolchain parity repair

- Preserve exact 1.11.86 as a locally validated and reproducibly built but remotely failed source candidate. Draft PR #10 bound both required checks to exact head `7590b41db1133b6267f6f0de27d5f3f082a7e1ff`; CodeQL passed, while CI stopped during the development-SBOM check because GitHub's moving Node 24 selector supplied npm 11.17.0 instead of the locally validated npm 11.16.0.
- The two generated SBOMs had the same 358 components, 417 dependency nodes, and 575,813 bytes. Their parsed content differed only at `metadata.tools.components[0].version`, so no dependency, source, license, or vulnerability result changed; the exact-file evidence binding correctly rejected the byte difference.
- Stage both GitHub workflows at Node 24.18.0, whose bundled npm 11.16.0 produced the recorded SBOM bytes. The substantive repair changes only remote workflow toolchain selection, while the required version transaction changes version-bearing runtime metadata and resets candidate-sensitive evidence without changing cleanup logic, permission authority, data scope, downloaded-file behavior, storage behavior, or messaging. A post-bump audit superseded 1.11.87 before complete validation after finding the earlier byte-exact wording and the newer compatible Node 24.18.1 security release.

## 1.11.86 — public-source prerelease work — 2026-08-25

### Forward 1.11.86 decision-binding truthfulness correction

- Preserve exact 1.11.85 as superseded before complete validation. Its version contract passed, but a post-transaction audit found that SW-075 incorrectly said the mutable Direct Cleanup decision JSON should not change even though the enforced publication contract requires `reviewedVersion` to bind the exact current candidate. No clean install, complete check, property suite, coverage run, build, artifact, browser run, commit, push, or publication result exists for 1.11.85.
- Correct SW-075 to distinguish the durable owner quotation and unchanged safety invariant set from the intentionally version-qualified mutable candidate binding. The current decision record must advance with the exact candidate while its verbatim owner statements, approval meaning, installed-evidence limits, and default-off/preflight/single-use/no-raw-route safeguards remain unchanged.
- Keep the separate remote-publication validator fixture version-neutral and retain outcome-neutral stable-document status wording. The substantive correction changes no runtime logic, cleanup authority, permission handling, browser data, downloaded-file behavior, storage behavior, or messaging; the required version transaction changes only version-bearing runtime metadata and candidate-sensitive evidence. These notes do not claim that the successor passed, was built, or was published.

## 1.11.85 — public-source prerelease work — 2026-08-25

### Forward 1.11.85 stable-document and test-fixture repair

- Preserve exact 1.11.84 as failed local-only history. Its first complete-check attempt stopped at 953/954 because the stale mutable Direct Cleanup decision record still named the previous candidate version. The property suite and required coverage command did not run, and 1.11.84 was never built, committed, pushed, or published.
- Replace stale version-specific current-candidate, branch, retest, artifact, and pending-status prose in stable documents with outcome-neutral references to the active automated, browser, release, and remote evidence records. Preserve exact 1.11.83 as the superseded local 952/952 pass and preserve every older installed failure in its original scope.
- Decouple the remote-publication contract fixture from ordinary candidate-number churn by using an explicitly synthetic semantic-version identity and matching branch/policy assertions. The fixture repair is test-only and does not change cleanup authority, permission handling, browser data, downloaded files, storage, or messaging.
- Stage these stable-input and test-fixture corrections for the next forward transaction. No current-candidate check, property, coverage, build, artifact, browser, remote, or publication pass is claimed by these notes.

## 1.11.84 — public-source prerelease work — 2026-08-25

### Forward 1.11.84 stable-document and synthetic 400% popup correction

- Preserve exact 1.11.83 as superseded local-only history: its complete local check and required coverage command passed 952/952, but it was never built, committed, pushed, or published. Stable status documents still described that result as pending, so those bytes cannot be promoted under the forward-only policy.
- Record SW-074 without overstating its evidence scope. A later synthetic popup run at the deterministic 400% fixture width of 95 pixels split short status and action words character by character. This was ChatGPT in-app Browser synthetic UI evidence, not an installed-extension, Chrome, Brave, native-prompt, accessibility, or supported-binary result.
- Stage a presentation-only popup correction for the successor: at 120 pixels and below, reduce shell/card/badge/action spacing and preserve normal whole-word wrapping for critical status badges and review actions. The change does not alter cleanup authority, permission acquisition or release, settings, browser data, downloaded files, storage, or messaging.
- Treat `docs/evidence/automated-validation-current.json` and the active browser-evidence pointer as the only current machine-status authorities. This entry records work to be validated; it does not claim that the successor passed, was built, or was published.

## 1.11.83 — public-source prerelease work — 2026-08-25

### Forward 1.11.83 narrow Options layout repair

- Preserve the exact 1.11.82 automated result as superseded local-only history: `npm run check` and the required coverage command both passed 952/952, but 1.11.82 was never committed, built, pushed, or published.
- Record the subsequent ChatGPT in-app Browser visual finding truthfully. At a 360-pixel viewport, the Expert **Optional embedded-frame access** status row computed as a `0px 255px` grid, collapsing its explanatory text to one character per line. This is synthetic web-UI evidence of a real narrow-layout defect, not installed-extension, accessibility, Chrome, or Brave evidence.
- Advance the minimal CSS-only correction to 1.11.83: at 560 pixels and below, stack `.setting-row.status-row` and remove permission-action width pressure. Do not change settings values, permission acquisition or removal, cleanup authority, browser data, downloaded files, storage, messaging, or any other product behavior.
- Require a fresh coordinated version transaction, local checks, coverage, narrow visual verification, clean exact-commit artifact build, and truthful candidate evidence before the 1.11.83 source branch or pull request proceeds.

## 1.11.82 — public-source prerelease work — 2026-08-25

### Deterministic lifecycle-test containment

- Retain the 1.11.81 automated record as superseded local-only evidence: it checked an intermediate stable closure that still contained a diagnostic terminal-poll expansion. Final diff audit removed that non-causal expansion before any 1.11.81 commit, build, artifact, or publication claim.
- Record the later full-file coverage result truthfully: after the expansion was removed, one 50-test lifecycle c8 run failed 49/50 at the successful grant case's terminal wait, while focused repetitions and three later isolated full-file runs passed. The combined evidence exposed cross-test contamination from escaped dynamically imported workers resolving a later replaceable global Chrome mock; host load can alter that scheduling window but is not the root cause.
- Advance the test-only closure to 1.11.82. Register the successful-grant and denial slow-maintenance cases before any other service-worker import in their file, retain the synchronous fake-timer reset that prevents a discarded retry timer, and replace the terminal iteration poll with an explicit five-second monotonic deadline plus bounded lifecycle diagnostics. Do not change packaged runtime behavior, product timeouts, coverage floors, cleanup authority, downloaded-file protection, or terminal postconditions.
- Keep SW-047 open for the broader dedicated-process/realm or immutable-mock binding improvement. The narrow first-registration containment is sufficient only for these release-blocking cases and is not installed-browser evidence.

## 1.11.81 — public-source prerelease work — 2026-08-25

### Deterministic lifecycle coverage repair

- Preserve exact 1.11.80 at local checkpoint `0eedffc82b63832ac3fff6956a209a379bdac1ef` with its truthful 951/952 coverage failure, then advance the test-harness-only repair to 1.11.81 rather than rewriting the sealed fingerprint.
- Reset the mocked clock in both slow-maintenance handoff cases in the same synchronous turn that fires the intended eight-second timeout. Promise reactions therefore create the later resume/backoff work only after real timers are restored, so reset cannot strand an awaited mocked timer and permanently block subsequent permission-grant signals.
- Add a pre-timeout assertion proving maintenance still owns the lifecycle, and keep every product timeout plus every exact completion, nonce, review, lease, temporary-access, mutation-count, denial, and downloaded-file-preservation assertion unchanged.
- Require fresh exact-1.11.81 targeted, complete lifecycle, full ordinary, and full coverage validation; diagnostic retries do not supersede the failed 1.11.80 gate. Keep SW-047 open as broader process/realm or immutable-mock isolation work; this narrow repair is neither production-race nor installed-browser evidence.

## 1.11.80 — public-source prerelease work — 2026-08-25

### Release-state truthfulness correction

- Preserve exact 1.11.79 at local checkpoint `8bef3391553689df14bd8a3db936611e895379c4` and advance the corrected stable closure to 1.11.80 instead of rebinding the checkpointed version.
- Narrow the synthetic visual record to what was actually observed: repaired Options initialization and fail-once recovery were seen, but no complete canonical Options assertion, all-settings interaction pass, installed-extension run, or accessibility pass was retained.
- Correct stale transaction tense, the August 24 repair-versus-August 25 publication-authorization chronology, and current review dates before the next candidate fingerprint is created.

## 1.11.79 — public-source prerelease work — 2026-08-25

### Fixture and release-state correction

- Serve the complete Options synthetic-module import closure, including `storage.js` and its `state-schema.js` dependency, and regression-test those exact routes so the visual/settings fixture cannot silently remain locked behind a 404.
- Supersede the locally committed and twice-reproduced 1.11.78 attempt with a forward-only 1.11.79 transaction instead of rebinding one version to two stable source closures.
- Correct current-candidate documentation and publication bindings for the 1.11.79 successor while retaining installed-browser, accessibility, performance, media, hosted-policy, independent-review, and authenticated remote-capture gates as pending.

## 1.11.78 — public-source prerelease work — 2026-08-24

### Fail-closed settings and scope repair

- Separate optional `webNavigation` access from settings saves: an explicit **Grant optional access** action opens the browser prompt, leaves embedded-frame discovery off, and requires a later setting enable. A rejected save never requests or revokes access. An explicit **Remove access** action first persists the feature off, while ordinary saves preserve access whenever the feature was already off; no permission-event ownership is inferred.
- Validate merged Expert associated-domain groups with the same structural capacity planner used by cleanup preflight, including live private-access cost, normalized duplicates, exact local origins, and Unicode/punycode scope.
- Construct cookie-removal URLs with valid bracketed IPv6 authorities while preserving domain, IPv4, path, store, secure, and partition-key behavior.

### Responsive and truthful UI

- Let the action popup shrink to the real viewport with one internal scroll owner, coherent long-text wrapping, and no character-by-character stacking while retaining the preferred 380×600 surface.
- Lock every settings control during an active job and state the request shield's effective profile-spanning, normal-only-suppressed, disabled, or unavailable behavior without promising protection that is not active.

### Release, evidence, and browser-harness integrity

- Build runtime and source archives from one clean exact Git commit, bind runtime bytes to committed blobs, keep builds side-effect-free, reject PATH-shadowed Git, verify two consecutive builds byte for byte, and validate a concrete reproducible development SBOM.
- Define and hash an immutable 24-case Chrome/Brave matrix, derive fixture defaults from production, constrain synthetic fixture hosts/routes/methods with per-run capabilities, and retain only mechanically derived `passed`, `failed`, `limited`, or `not_run` results.
- Carry the unchanged default-off Direct Cleanup owner decision forward to 1.11.78 only after the semantic contract accepts the actual version-matched decision and continues to reject permission-removal poison and stale-regrant mutations.
- Record the owner's 2026-08-24 authorization for the exact 1.11.78 audit, repair, build, and browser-validation work separately from the later 2026-08-25 authorization for GitHub and public-release actions. The later authorization permits execution only when the corresponding exact-artifact, reviewer, remote-policy, and publication gates genuinely pass; it does not convert pending, limited, failed, or unreviewed evidence into approval and does not itself establish a supported binary.

## 1.11.77 — public-source prerelease work — 2026-08-24

### Bounded cleanup and truthful outcomes

- Carry explicit completeness evidence through capped history, download, cookie, tab, and storage discovery so an incomplete scan cannot be reported as verified zero. Reject malformed browser inventories instead of coercing them into empty or successful results.
- Admit cleanup only after a complete read-only capacity observation proves the frozen target tab/window scope and conservative query plan fit below the operation ceiling. Preserve useful bounded download matches without allowing file deletion from an incomplete inventory, keep required cookie discovery ahead of optional probes, and report demand, allocation, and omissions separately.
- Use the exact reviewed source window for progress overlays, keep exact-origin and partition limits explicit, and return structured reset, report-clearing, permission-recovery, and request-shield maintenance outcomes without presenting partial work as success.

### UI, accessibility, and recovery

- Keep the popup at a definite action width while preserving 400-percent reflow when opened as a page. Separate actionable cleanup-capacity guidance from expandable technical detail, use browser-neutral recovery copy across shipped surfaces, and keep the side panel's visual settings live before a report is bound.
- Keep the persistent permission-handoff review at the top of the document when it becomes ready instead of moving focus to an off-screen action. Restore visible focus indicators, including forced-colors mode; retain error notices until explicitly dismissed; restore focus after dismissal; keep disabled-setting explanations at full contrast; and expose narrow-screen Options navigation without horizontal overflow.
- Preserve the exact associated-domain input bounds while reporting every ignored or shortened line, and retire an abandoned Direct review only when its original popup is proved closed and the authority remains unarmed, uninvoked, and unable to settle a permission prompt. Live or uncertain authority continues to fail closed.

## 1.11.67 — public-source prerelease work — 2026-08-23

- Replace the remaining coverage-only permission-settlement timing race with causal test-harness synchronization that parks the exact load-readiness retry whose absence defines the regression. The test proves that interception occurred and restores the real timer before constructing the reviewed approval; production runtime behavior is unchanged.
- Correct stable release documentation to separate the authorized source-candidate branch/pull-request stage from later installed/browser, merge, binary-publication, and owner-authorization gates. No merge, tag, GitHub Release, supported-binary publication, browser-store submission, promotion, or portfolio approval is recorded.

## 1.11.66 — public-source prerelease work — 2026-08-23

- Apply the repository formatter to the three current-candidate rows in the issue register after the 1.11.65 pre-push format check rejected their table alignment. This is a Markdown formatting and version-integrity correction only; production runtime behavior is unchanged.

## 1.11.65 — public-source prerelease work — 2026-08-23

- Synchronize stable current-candidate documentation and branch references after the deliberate 1.11.64 version transaction exposed stale predecessor text. This is a documentation/version-integrity correction only; production runtime behavior is unchanged.

## 1.11.64 — public-source prerelease work — 2026-08-23

- Make the permission-settlement lifecycle regression deterministic under coverage instrumentation. The test now suppresses every undelayed timer only during its narrowly scoped synthetic approval-arm call, so unrelated coverage/runtime bookkeeping cannot consume a single "next timer" interception and allow the separately tested automatic wake to race this assertion. Production runtime behavior is unchanged.

## 1.11.63 — public-source prerelease work — 2026-08-23

- Retain exact installed SiteWipe 1.11.62 as failed historical evidence. Chrome 151 completed the reviewed `example.com` cleanup but also cleared persistent `chips.localhost` page storage partitioned beneath the selected top-level site; the old review and fixture language incorrectly treated that browser-defined selected-site effect as out-of-scope preservation. The out-of-domain CHIPS cookie remained because cookie cleanup is separately host-scoped.
- Correct the storage-scope contract for the forward successor: registrable-site browser-level cleanup explicitly includes third-party page storage partitioned beneath the selected top-level site and may leave the selected origin's partitions beneath unrelated top-level sites; exact-origin-only browser-level closed-page storage/cache is skipped because Chrome/Brave's schemeful-site key cannot preserve ports. Exact live-page cleanup remains available, closed-page limitations are reported, and SessionStorage is evaluated separately from persistent partition evidence.
- Enforce the exact-origin storage skip again at the final browser-data mutation boundary, with only the separately disclosed cookie-only host-scoped sweep exempted. Reset any older saved direct-cleanup opt-in during the 1.11.63 disclosure migration so the current selected-site and exact-origin limitations must be acknowledged before direct mode can be re-enabled.
- Rename the non-reseeding fixture route a read-only partition-observation probe. It now documents target-associated partition deletion, unrelated-top-level preservation, separately host-scoped CHIPS-cookie preservation, and the no-cleanup control needed to distinguish cleanup from navigation.

## 1.11.62 — public-source prerelease work — 2026-08-23

- Keep an invoked native site-access prompt's non-runnable review tombstone and durable lease after the five-minute review expires. Ordinary in-session maintenance now waits for both the exact host-only permission event and the bound handoff document's literal-true outcome; only a real browser-session boundary may discard an unresolved prompt without observing its result.
- Persist the exact handoff's terminal canceled/reconciled result so concurrent wake-only maintenance cannot turn a proven late-grant release into an indefinite or misleading outcome. Added an installed-order regression covering an unresolved Chrome prompt across expiry, a later exact four-pattern grant, no cleanup admission, exact access reconciliation, and downloaded-file preservation.

## 1.11.61 — public-source prerelease work — 2026-08-22

### Startup-lifecycle test isolation

- Register the readiness-retry regression before other mock service-worker generations in its test file. This preserves the full production assertion while preventing obsolete test-only worker instances from sharing a later global Chrome mock and racing the admitting review.

## 1.11.60 — public-source prerelease work — 2026-08-22

### Persistent-handoff timeout contract correction

- Update the messaging-client timeout regression to exercise the current persistent-handoff grant and resume routes instead of the retired popup continuation routes. Production already assigned the long cleanup-response budget to the current routes; this test-only correction closes the full-suite failure without changing runtime behavior.

## 1.11.59 — public-source prerelease work — 2026-08-22

### Release transaction formatting correction

- Keep the version transaction's generated changelog and release-readiness Markdown formatted before their stable-input fingerprint is computed. The local 1.11.58 transaction was never built, installed, pushed, or published; the forward-only integrity rule advances this formatting-only correction to a new candidate version instead of silently rebinding 1.11.58.

## 1.11.58 — public-source prerelease work — 2026-08-22

### Persistent native-permission handoff

- Treat the exact installed 1.11.57 Brave result as a failed first-grant run: Brave accepted the four reviewed `example.com` patterns but destroyed the action popup before it could report the native request's literal-true result, so the worker correctly kept the lease proofless and started no cleanup.
- Move the second, user-activated permission step into a dedicated extension-owned tab that survives Chrome/Brave's native prompt. Bind a worker-minted, single-use in-memory capability to that exact tab context while retaining the independent pre-request absence inventory, literal-true result, exact host-only `permissions.onAdded` event, nonce-bound approval, one-job admission, and proven temporary-access release requirements.
- Add teardown and replay regressions that require exactly one admitted cleanup after the persistent page reports all proofs, preserve downloaded files, and remain fail-closed when that page disappears before reporting the native result.
- Retain the exact used handoff binding until its worker-opened tab closes so a lost completion response can recover the same running or terminal job without admitting a duplicate cleanup; if recovery itself is unavailable, show an uncertainty-safe warning instead of claiming that no cleanup started.
- Serialize an external target-access removal against every in-flight SiteWipe release, re-check the durable lease immediately before the native removal, and treat a pre-admission `reviewed_prompt_grant` without its exact matching live review as ambiguous after restart. Stale bookkeeping is discarded while a later manual regrant is preserved; only durably `admitted_cleanup` ownership remains eligible for ordinary restart-time release.

## 1.11.57 — public-source prerelease work — 2026-08-22

### Recovery proof and publication-contract correction

- Preserve a proofless first-activation review and any later manual host-access grant across worker restart. Restart invalidation now treats access as SiteWipe-owned only when the durable review contains the complete authenticated invocation, exact grant event, literal-true popup outcome, and pre-request absence proof; missing-access settlement reuses the existing lifecycle reservation and never removes an unowned grant.
- Rebind the two permission-listener mutation checks to the current service-worker structure through the parsed JavaScript syntax tree. The contract now proves that permission events cannot synthesize popup grant outcomes and that removal poison is installed before serialized invalidation, without relying on retired neighboring source text.
- Keep follow-up hardening and evidence-automation ideas in the issue register as explicitly non-blocking deferred work.

## 1.11.56 — public-source prerelease work — 2026-08-22

### Authenticated second-activation permission handoff

- Keep activation one arm-only and non-runnable. On activation two, dispatch capability-authenticated, non-runnable `beginCleanupPermissionPrompt` intent without awaiting; synchronously start `permissions.getAll()` immediately before invoking the exact preflight-bound `permissions.request()`; and immediately dispatch authenticated `confirmCleanupPermissionPromptInvocation` without awaiting either native result. Advance the handoff schema to 2, let confirm persist only `promptInvocation`, separately persist the exact complete post-begin host-only `permissions.onAdded` event as `promptGrant`, and have the initiating popup send and await `confirmCleanupPermissionGrantOutcome` only when the request resolves literal `true` and the pre-request inventory validly proves every reviewed temporary origin was absent from exact and broad coverage. Persist that proof as `promptGrantOutcome` with `preRequestTemporaryOriginsAbsent: true`; rejected, malformed, or already-covering inventory records no outcome.
- Require the conjunction of `promptInvocation`, `promptGrant.complete === true`, `promptGrantOutcome.granted === true`, and `promptGrantOutcome.preRequestTemporaryOriginsAbsent === true` at readiness, atomic consumption, worker takeover, and prompt-owned permission removal. Invocation, access possession, or either grant proof alone cannot admit cleanup or authorize removal. A resolved-true outcome without its event remains non-runnable and pending through the live review/tombstone window even after bounded resume retries, so a delayed exact event can still complete once. If no event arrives before expiry/session settlement—or the popup disappears before reporting literal `true`—start no cleanup, discard only SiteWipe's review/lease bookkeeping, and preserve the grant. Grant events cannot synthesize popup proof; popup proof cannot synthesize event observation. A synchronous browser-API throw uses authenticated `not_invoked` settlement with the same preservation result. Give unconfirmed intent a dedicated 30-second `reviewPromptConfirmation` alarm while preserving the original five-minute `reviewExpiry`; expiry/invalidation/reset produces non-runnable `prompt_intent_tombstone`, and confirm converts it to `prompt_tombstone`.
- Advance the durable permission lease to schema 3 with explicit `ownershipProof` provenance. Record `reviewed_prompt_grant` only after the session handoff durably contains the complete invocation/event/outcome/absence proof; require it before admission upgrades the lease to `admitted_cleanup`; and retain that proof through `release_pending` so startup may retry only proven SiteWipe-owned release obligations. Proofless, legacy, or `revoked` leases discard bookkeeping and preserve access. Serialize intersecting `permissions.onRemoved` events to revoke ownership and invalidate pending review authority, so a later manual regrant cannot inherit stale cleanup or permission-removal authority.
- Move the isolated service-worker prompt-settlement reservation regression into its own safety test realm and drain the bounded startup wake before constructing the late-grant case, preventing test-only lifecycle leakage and older wake races under a slower full-suite run without changing product timing.
- Bind syntax validation to the declared public source closure, excluding ignored disposable browser profiles so the release count is deterministic from a clean checkout.

## 1.11.55 — public-source prerelease work — 2026-08-22

### Release-contract assertion alignment

- Align the accessibility and preflight source assertions with the formatted direct-mode notice and the two-activation missing-access button state, so the full release suite verifies the implemented grant handoff instead of the retired one-expression label contract.

## 1.11.54 — public-source prerelease work — 2026-08-22

### Durable first-grant handoff and partition-observation correction

- Retain the exact installed SiteWipe 1.11.53 Chrome failure as historical evidence. In a fresh disposable Chrome `151.0.7922.172` profile, Chrome granted the four reviewed `example.com` patterns, but the non-awaited `armCleanupApproval` message was not durably recorded before the popup lifetime ended. The worker correctly refused the wake-only permission event: no cleanup job or report was created and no fixture or downloaded-file mutation occurred.
- Record the later 1.11.53 Standard cleanup only as a narrow pregranted-path pass. It closed the matching fixture tab and left target local/session storage, IndexedDB, caches, service workers, and cookies at zero, while the protected 63-byte fixture download remained byte-identical. The surviving `chips.localhost` partitioned cookie is an expected out-of-scope preservation canary, not `example.com` residue; a real exhaustive cookie-discovery/removal regression now proves that the partition key cannot broaden cookie ownership.
- Split missing normal-window access into two SiteWipe activations. The first awaits an exact nonce-bound durable `armed` acknowledgement and cannot open the native prompt or start cleanup. Only then does the same still-live popup expose a second fresh action whose first asynchronous browser API is `permissions.request()` for the exact missing patterns. Pregranted cleanup remains one SiteWipe activation, permission possession/events remain wake-only, and a replacement popup cannot inherit the document-bound capability.
- Extend popup, browser-fixture, worker, authorization, recovery, expiry, denial, teardown, event-before-arm, cross-document non-transfer, redaction, and downloaded-file-preservation regressions. Exact 1.11.54 Chrome and Brave first-grant validation remains pending and must bind a new reproducible runtime artifact.
- Record the 2026-08-22 owner amendment approving the exact one-activation pregranted/two-activation missing-access interaction for the 1.11.56 source candidate. Merge, tag, GitHub Release, browser-store submission, promotional publication, runtime-artifact approval, and complete installed-browser evidence remain separately withheld or pending.

## 1.11.53 — public-source prerelease work — 2026-08-22

### Hosted privacy review-line contract

- Put the local privacy review date on its own exact line so the enforced hosted-policy evidence parser can bind the reviewed date without discarding it when adjacent status prose changes.
- Keep the current validation and hosted-policy status in a separate sentence, preserving the forward-only candidate rule and requiring fresh exact-version evidence before source upload.

## 1.11.52 — public-source prerelease work — 2026-08-22

### Live permission-recovery reconciliation

- Re-query the worker's normalized temporary-access status when the durable permission lease changes and immediately before **Clean another site** leaves a report. Keep local cleanup flows visible, but replace any idle/report composer with the recovery explanation until the worker proves `state: none`; then remove the stale lock and restore the report or composer.
- Make the two missed-automatic-wake lifecycle tests explicitly suppress and assert the arm timer whose absence defines their premise. Keep serial file execution for host-contention isolation without using it as a substitute for deterministic per-test ordering.

## 1.11.51 — public-source prerelease work — 2026-08-22

### Recovery-layout harness completion

- Expose the popup harness's existing class-list state through a read-only assertion helper so the recovery-layout regression verifies both the dedicated recovery class and the absence of the conflicting review class.

## 1.11.50 — public-source prerelease work — 2026-08-22

### Deterministic lifecycle validation

- Serialize Node test files in the official unit and coverage runner. The files model independent extension service-worker lifecycles with bounded browser-operation timers; running them concurrently under coverage instrumentation produced different one-off timeout assertions while each exact case passed in isolation. Serial execution removes cross-file CPU starvation without weakening any product timeout, expectation, coverage threshold, or safety assertion.
- Keep permission-recovery and unverified-handoff guidance visibly isolated in a dedicated recovery popup state. The recovery state locks and hides the cleanup composer while deliberately leaving its progress/status card rendered; source and popup-harness regressions reject the review-mode selector that previously hid that explanation.

## 1.11.49 — public-source prerelease work — 2026-08-22

### Permission-recovery status truthfulness

- Prevent a replacement popup from presenting an ordinary Ready composer while the worker still owns a prepared, prompt-pending, active-cleanup, release-pending, or invalid temporary target-access record. Expose only the redacted lease state and exact-pattern count, lock new cleanup, and direct the user to Options → Maintenance without claiming that cleanup did or did not start.
- Verify the native permission request still runs with live user activation after the handoff reorder, and distinguish the worker's deliberate event-before-arm stress test from the installed popup's new arm-before-request order.

## 1.11.48 — public-source prerelease work — 2026-08-22

### Corrective-candidate formatting normalization

- Supersede 1.11.47 before artifact construction or installed validation because the handoff correction's architecture, testing, and issue-register documentation still required the repository's mechanical formatter after that version transaction.
- Preserve the native-prompt teardown correction and its regression while advancing monotonically so the next candidate fingerprints only the final formatted stable inputs.

## 1.11.47 — public-source prerelease work — 2026-08-22

### Native-prompt popup-teardown handoff correction

- Retain the exact installed 1.11.46 Brave failure as historical evidence: Brave granted the four reviewed `example.com` patterns but destroyed the action popup inside `permissions.request()` before the following arm-dispatch statement could run. The worker correctly admitted no cleanup without an authenticated `armed` record; no fixture data, DNR rule, report, job, or downloaded file changed, and expiry maintenance reconciled the temporary-access lease.
- Dispatch the capability-authenticated, non-runnable worker arm first without awaiting it, then invoke the native permission request immediately in the same trusted click task and keep the permission result as the first await. Exact, unexpired handoff and permission proofs remain mandatory before admission, so the reordered call cannot authorize cleanup by itself.
- Add a popup regression that fires `pagehide` synchronously from the permission-request stub and never settles the prompt, proving the arm and raw popup capability have already left while no popup resume or direct cleanup route runs. Fresh reproducible artifacts and installed Chrome/Brave validation are required under the next forward-only version.

## 1.11.46 — public-source prerelease work — 2026-08-21

### Permission-expiry and partition-observation hardening

- Close the exact late-grant expiry gap observed in the installed 1.11.45 Standard run and the deadline-admission and stale-control defects found during 1.11.46 review. After the native prompt settles, the initiating popup reconciles the authenticated capability/nonce-bound worker outcome before choosing its copy: an admitted running job or terminal report remains authoritative, and only a proven canceled handoff with `cleanupStarted: false` plus strict temporary-access absence may say that no cleanup started and access was released. An unprovable outcome retains the binding, locks fresh cleanup, and directs the user to the current job/report or Options without claiming admission or release. The worker—not the popup—settles or revokes only preflight-classified temporary exact origins, and the popup retires stale review controls while keeping the outcome guidance visible.
- Add a distinct read-only `chips.localhost` partition-observation probe. The legacy `embed=1` route remains setup-only and auto-seeds, while `/partition-probe` embeds a snapshot-only frame that ignores `autoseed`, exposes no seed/reset API, disables and hides mutation controls, removes the download target, emits no seeding cookie, and documents the same-scheme/site/port before-and-after protocol. Its original preservation interpretation was later superseded by the Chrome 151 semantics recorded under SW-049.
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
