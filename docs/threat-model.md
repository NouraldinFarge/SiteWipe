# Threat model

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

Last reviewed: 2026-08-23. Exact installed SiteWipe `1.11.57`, `1.11.61`, and `1.11.62` are retained as failed historical evidence. The 1.11.62 run proved that Chrome's selected-top-level-site partition semantics were not disclosed by the candidate and that exact-origin-only browser-level storage deletion cannot preserve ports. This model covers the 1.11.67 corrective working source that discloses registrable-site target-associated partition deletion, skips exact-origin-only browser-level closed-page storage/cache, retains the prior prompt-expiry correction, replaces the remaining coverage-only permission-settlement timing race with causal test-harness synchronization, and corrects stable release-stage wording without changing production behavior. The active automated evidence record is authoritative for local validation and reproducible-artifact status; exact-artifact installed review and each stage-specific publication decision remain separate gates. It does not cover a future store-signed artifact or unrelated product using the same name.

## Security goals

1. A destructive operation stays inside the freshly authorized, normalized, preflight-bound scope, including the explicitly disclosed selected-top-level-site effect for registrable-site page storage; detailed review is the default, and optional direct mode requires a separately confirmed saved setting in Standard or Expert.
2. No browser-data mutation occurs before a fresh, context-bound, single-use `detailed_review` or setting-derived `settings_direct` approval is consumed.
3. Passwords, passkeys, bookmarks, Sync/account state, autofill profiles, and payment methods remain outside all cleanup paths.
4. Extension-owned request blocking cannot be silently orphaned after interruption.
5. Failed, unavailable, or timed-out work is reported as uncertain rather than successful.
6. Locally retained reports minimize browsing-data exposure and expire as described.
7. Untrusted pages, messages, imports, stored records, and generated artifacts cannot broaden authority.

## Assets

- unrelated sites' cookies, storage partitions beneath unrelated top-level sites, tabs, history, and download records; embedded third-party page storage partitioned beneath the selected top-level site is target-associated only after the explicit registrable-site disclosure;
- downloaded files and other irreplaceable local data;
- protected credential, account, autofill, payment, and bookmark stores;
- private-window browsing details;
- the accuracy of scope, progress, verification, and limitation reports;
- browser availability after temporary DNR rules;
- release integrity, source/package equivalence, and third-party provenance.

## Trust boundaries

| Boundary                           | Untrusted input                                                               | Required control                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User input → scope model           | URLs, Unicode, ports, credentials, suffixes, associated groups                | Canonical parsing, PSL resolution, safe schemes, protected-target guard, fail closed                                                                                                                                                                                                             |
| Extension page → service worker    | Message type, stale response, and payload                                     | Version/correlation envelope, extension-origin sender check, exact schemas, size limits, timeouts, unknown-field rejection                                                                                                                                                                       |
| Web page → injected script/message | Hostile page JavaScript and DOM                                               | Isolated execution world, internal target matcher, narrow cancellation-only message route                                                                                                                                                                                                        |
| Stored state/import → runtime      | Corruption, old versions, manual tampering, oversized/foreign settings backup | Size/schema/app/version/key/value validation, explicit import preview/confirmation including direct-mode risk, complete preflight-snapshot reconstruction, current-settings/private-access revalidation, strict lease/inventory validation, serialized mutations, safe defaults                  |
| Runtime → Chrome APIs              | Differing API scope/StorageKey semantics and review-to-use races              | Per-adapter target/private-scope guards; explicit registrable-site selected-partition disclosure; exact-origin-only browser-storage skip; separate cookie host scope; final origin/tab/download-identity validation; run-wide budgets; bounded queries; no global/time-based browsing-data calls |
| Runtime → DNR                      | Interrupted or late asynchronous rule mutation                                | Reserved IDs, intent persisted first, full-range diagnostics, pending-install settlement tracking, and retained unknown state                                                                                                                                                                    |
| Report → storage/export/support    | Browsing URLs, paths, API error text                                          | Central schema-aware and free-form redaction, serialized leak checks, refreshed checksum                                                                                                                                                                                                         |
| Source → release artifact          | Unknown/symlinked files, stale ZIP, remote code, secrets, stale evidence      | Explicit runtime/source closures, AST scan, staged canonical directory, archive reinspection, exact byte/timestamp parity, checksums and SBOM                                                                                                                                                    |

## Threat analysis

### Cross-tenant or lookalike over-deletion

**Attack/failure:** `alice.blogspot.com` is reduced to `blogspot.com`, a concatenated lookalike matches, or an associated target bypasses normalization.

**Controls:** the complete pinned PSL includes PRIVATE rules; matchers require exact/dot boundaries; associated items are normalized separately; the live-page function repeats the same boundary checks; unknown suffixes fail closed. Exact live-page targets retain scheme and port, while browser-level closed-page storage/cache is skipped for exact-origin-only scope because Chrome/Brave's schemeful-site partition key cannot retain the port boundary.

**Evidence:** official PSL corpus tests, named hosted-platform regressions, property tests, and a sibling-tenant invariant spanning origins, tabs, page scrub, cookies, history, downloads, DNR, and verification. Installed-browser fixture evidence remains pending.

### Browser storage partitions exceed a data-origin label

**Attack/failure:** a registrable-site review says only “origin-scoped storage,” but Chrome/Brave also delete LocalStorage, IndexedDB, Cache Storage, file-system data, service workers, and related data owned by an embedded third party when that data is partitioned beneath the selected top-level site. Conversely, a selected origin's partitions beneath unrelated top-level sites may remain. For an exact local origin, the browser's schemeful-site key ignores ports and can cross the reviewed port boundary.

**Controls:** detailed review explicitly discloses the selected-top-level-site effect for every registrable-site target, and saved direct authorization binds the same policy without pretending the per-run screen was shown. The report distinguishes browser-level selected-site partition cleanup from exact live-page work. Exact-origin-only scope never reaches browser-level closed-page storage/cache; live-page cleanup retains exact scheme/host/port matching and reports closed-page storage as partial or unavailable. Cookies remain separately host-scoped, so an out-of-domain CHIPS cookie is not selected merely because its partition key names the target. SessionStorage is reported separately because top-level tab closure destroys its browsing context.

**Evidence:** exact installed SiteWipe 1.11.62 is retained as a failed historical run under SW-049. Its no-cleanup control preserved persistent `chips.localhost` LocalStorage and IndexedDB, while the reviewed `example.com` cleanup cleared the same target-associated partition and preserved the out-of-domain CHIPS cookie. Corrective source tests must prove registrable-site disclosure and selection, exact-origin skip/reporting, cookie separation, and report truthfulness; a forward exact-artifact Chrome/Brave retest remains required.

**Residual risk:** browser versions and storage backends can differ. Selected-origin partitions beneath unrelated top-level sites may remain, and browser APIs do not enumerate every such partition for complete verification. Unsupported or unexposed surfaces remain limitations rather than verified zero.

### Destruction before meaningful consent

**Attack/failure:** an unrequested primary action, caller-provided skip flag, raw/unbound direct message, replayed token, changed settings/window/private context, forged acknowledgement or file list, stale page, or alternate message route starts deletion.

**Controls:** preflight inspection uses read APIs only and only one live approval record may exist. Detailed review is the default in Standard and Expert and renders the complete fresh target, cleanup mode, associated scope, categories, impacts, unknowns, exact required site-access patterns, retention, request-shield behavior, irreversible file effects, limitations, and verification boundary. With exact access pregranted, its final approval submits `detailed_review` in one SiteWipe activation.

The default-off `skipCleanupReview` setting can be enabled only after an explicit Settings warning. The 1.11.63 storage-partition disclosure migration resets any older saved opt-in to false before cleanup admission, so selected-site and exact-origin limitations must be acknowledged before direct mode can be re-enabled. When true, SiteWipe prepares the same hidden read-only snapshot and durable `prompt_pending` lease before **Clean now**. With pregranted access, one activation submits `settings_direct`. With missing access, activation one durably arms only, requests no permission, starts no cleanup, and causes the worker to create or focus one exact extension-owned handoff tab. That tab can claim the approval only from the recorded worker-created tab ID, packaged URL, extension origin, top frame, and one worker-resolved `TAB` `contextId`; optional `MessageSender.documentId` is not required and cannot replace `contextId`. Activation two occurs in that exact bound document. It dispatches begin, synchronously starts `permissions.getAll()` immediately before the exact request, and dispatches invocation confirmation before awaiting. Only literal true plus a valid inventory proving all reviewed temporary origins absent from exact and broad coverage may record authenticated `promptGrantOutcome` with `preRequestTemporaryOriginsAbsent: true`; separately, one exact complete host-only event records `promptGrant`. Cleanup requires the conjunction plus schema-3 `reviewed_prompt_grant` lease provenance recorded only after the complete session proof. Private-source and raw-route boundaries remain unchanged.

Token consumption occurs before mutation and reconstructs the complete authority snapshot. Every approval is random, single-use, session-scoped, and cleanup authority expires after five minutes. The popup preparation capability and separately minted handoff capability remain bound to their exact extension documents; raw values exist only in page memory, and only their digests persist. The static handoff URL contains no nonce, token, capability, target, or host pattern. Direct-open, duplicate, reload, navigation, replacement, wrong-frame, wrong-tab, wrong-context, replay, and expired handoff attempts fail closed; replacement popups are recovery-locked. A separate 30-second confirmation alarm governs unconfirmed begin intent. Once invocation is authenticated, ordinary expiry and periodic maintenance retain a non-runnable prompt tombstone and lease while the native browser prompt can still resolve. Resume/event cannot synthesize outcome or pre-request absence; handoff-page outcome cannot synthesize event. Cleanup remains forbidden after expiry. In-session late-grant removal requires both the exact complete event and the bound document's literal-true/pre-request-absence outcome, and its nonce-bound terminal cancellation is persisted before concurrent wake-only recovery can obscure the result. Unobserved prompt bookkeeping may be discarded only after explicit denial/dismissal or a real browser-session boundary where the old native prompt cannot later grant access. Admission upgrades reviewed ownership to `admitted_cleanup`, and `release_pending` retains it across restart. Intersecting `permissions.onRemoved` revokes ownership and pending authority; manual regrant cannot reuse stale proof. Proofless, legacy, and revoked records preserve access. Detailed/direct and file-ID boundaries remain unchanged.

**Residual risk:** direct mode intentionally removes per-run visibility and acknowledgement, so a settings choice may remain enabled when the user later changes Expert effects. Browser data can change after preflight and final adapter revalidation; Chrome's asynchronous state can still race. A malicious local actor controlling the extension process or device can defeat UI consent. If the handoff page or worker stops after a permission grant but before worker admission finishes, the new pattern can remain through the conservative prompt-pending recovery window or longer if Chrome refuses removal; the durable lease preserves the obligation across restart. Exact-artifact detailed/direct/native-prompt/incognito evidence remains a release gate under ADRs 0011 and 0013.

### Private-window authority expands after preflight

**Attack/failure:** a run preflighted with normal-window scope later consults the browser's live global incognito setting and begins discovering, injecting into, changing, closing, or verifying private tabs that were never bound.

**Controls:** consumption requires the browser private-access state to equal the preflight-bound value. The consumed approval carries that immutable value through scope discovery, tab-state changes, page scrub, progress overlay, tab closure, and verification. Each tab is filtered or re-read against both target and bound private scope. A private-source direct run requires exact target access before preflight so no missing private target pattern is requested or written to durable permission-lease state. False→true, true→false, discovery, navigation, injection, progress, closure, and verification regressions exercise the boundary.

**Residual risk:** installed Chrome/Brave incognito spanning behavior, window races, extension reload, and native extension-settings changes remain pending exact-artifact tests. Browser state may still change after the final re-read and before an asynchronous mutation finishes.

### Temporary permission ownership is lost or corrupted

**Attack/failure:** a service-worker/browser restart loses the session approval after Chrome grants host access, or malformed durable state causes SiteWipe to remove a grant that existed before preflight.

**Controls:** preflight canonicalizes exact and relevant broad access into a durable lease. Activation one arms only and the worker creates or focuses the exact extension-owned handoff tab. Activation two in its exact bound document dispatches begin, synchronously starts `permissions.getAll()` immediately before `permissions.request()`, and immediately confirms invocation before awaiting. The event handler accepts only one exact complete canonical host-only event. The bound handoff document may confirm outcome only after literal true and a valid pre-request inventory proving no reviewed temporary origin exact- or broad-covered; missing, rejected, malformed, or covered inventory records no outcome. Readiness, consumption, takeover, and removal require the unexpired arm, exact tab/context/capability binding, invocation, complete event proof, literal-true outcome, pre-request absence, schema-3 reviewed/admitted ownership provenance, full reconstruction, and current exact grant. `release_pending` preserves provenance; startup removes only reviewed/admitted owned access. An intersecting removal serially sets ownership to `revoked` and invalidates the pending review before any later manual grant can be admitted. True-only remains pending for lagging event delivery; terminal incomplete, legacy, proofless, and revoked records preserve access and cannot remove. Private-source and broader/pre-existing access remain excluded from removal.

**Residual risk:** Chrome can refuse permission removal or make permission state unavailable. In that case access and the recovery record can remain until a later retry or manual revocation. Installed Chrome/Brave restart evidence is still required.

### Compromised page falsifies cleanup

**Attack/failure:** page code replaces storage APIs or spoofs results when cleanup executes in `MAIN` world.

**Controls:** the former MAIN-world path is forcibly disabled regardless of migrated settings. Injection uses the isolated extension world and carries a self-contained matcher. Results remain best effort and are not treated as cryptographic proof.

### Browser API hangs or finishes after timeout

**Attack/failure:** an API times out, the service worker proceeds, and a late mutation makes the report inaccurate.

**Controls:** timeouts are labeled unknown, never ordinary zero/failure; verification uses explicit states; DNR recovery records survive uncertainty; tab-removal timeouts increment timed-out and unknown rather than definite failure/success; normalized adapter outcomes expose attempted/succeeded/failed/timed-out/unknown/skipped/capped counts; final reports include errors/limitations. Run-wide duration/query/record budgets stop scheduling new work after their ceiling, and cancellation-check failures or a missing/replaced active-job identity stop the old run instead of being interpreted as permission to continue. Operations that cannot be safely canceled are never promised canceled.

**Residual risk:** Chrome APIs generally do not expose abort handles. A timed-out underlying operation may complete later.

### Orphaned request shield

**Attack/failure:** worker termination occurs between DNR mutation and state update, leaving target requests blocked without visible recovery state.

**Controls:** recovery intent is persisted before install; rule IDs are restricted to `730000–730499`; clear paths remove the entire owned range; diagnostics must prove zero before forgetting; observed orphan rules reconstruct an unknown recovery record. When installation times out but its original promise is still pending, a point-in-time empty range is explicitly provisional and the durable recovery obligation remains until later reconciliation runs after settlement.

**Residual risk:** if both DNR inspection and local state are unavailable, the extension cannot prove shield state until a later browser wake or reload.

### Downloaded-file candidate changes after preflight

**Attack/failure:** a download ID is reused or its URL, final URL, referrer, filename, completion state, or disk-presence state changes between discovery and irreversible `removeFile`.

**Controls:** file deletion remains Expert-only, off by default, preflight-ID-bound, and ordered before record erasure. Detailed mode separately requires the typed normalized target. Saved direct authorization intentionally skips that phrase and truthfully reports that no per-run phrase occurred. Immediately before `removeFile`, SiteWipe performs an exact-ID `downloads.search` and requires one live record whose target match, completion/existence state, approval, filename, URL, final URL, and referrer all still equal the preflight candidate. Any uncertainty preserves the file and its browser record.

**Residual risk:** Chrome and the operating system do not provide an atomic compare-and-delete transaction; the file can still change after the final query. Only disposable synthetic files may be used for installed validation.

### Report or diagnostic privacy leak

**Attack/failure:** URL/path canaries survive inside free-form error labels, nested data, HTML/text exports, debug logs, or support bundles.

**Controls:** one central recursive redactor handles structured fields plus URL, host, IP, extension-ID, local/posix-path, secret-parameter, and probable-filename detectors; stable domain hashes are avoided; export transforms refresh SHA-256; adversarial serialization tests reject surviving canaries; debug/job/shield snapshots are scrubbed. Completed reports are never persisted while private-window access is enabled because affected private scope cannot be proven absent.

**Residual risk:** redaction is not anonymization. Unknown string formats, timestamps, counts, and contextual combinations may identify activity. Users must inspect exports before sharing.

### Message spoofing or malformed state

**Attack/failure:** another extension, a web page, oversized payload, unexpected field, or corrupted storage activates a privileged route.

**Controls:** the service worker validates every declared message type and sender. Requests and responses carry a protocol version and correlation ID; UI callers enforce bounded response deadlines. The permission-handoff claim additionally requires the exact worker-recorded tab, packaged URL, extension origin, top frame, and unique worker-resolved `TAB` context; direct-open, copied, duplicated, reloaded, navigated, replaced, stale, and wrong-capability pages cannot continue. Optional sender `documentId` may only be a cross-check, never required identity or a substitute for `contextId`. Target-page messages may only request cooperative cancellation. State schemas bound strings, arrays, IDs, timestamps, sizes, transitions, review content, and permission ownership. Serialized read-modify-write paths prevent report/settings/job/shield races, and a cancellation request is monotonic across progress writes.

### Stale or hostile Settings operations broaden authority during cleanup

**Attack/failure:** a stale full-form Options save, oversized/foreign backup, mode switch, reset, shield repair, or manual maintenance runs during an active cleanup or silently revives an Expert-only optional permission.

**Controls:** background settings/reset/shield/maintenance/local-reset routes reject a live cleanup, with disabled/ARIA-explained Options controls as usability defense in depth. Settings backups are size-bounded, SiteWipe schema/app/version checked, allowlisted, value-validated, summarized, and explicitly confirmed before one background save. Standard mode, entry into Expert, feature disable, and reset persist embedded-frame discovery off and remove `webNavigation`; enabling it requires a later explicit Expert gesture.

**Residual risk:** Options source contracts do not prove installed focus, stale-tab, native prompt, imported-file, or concurrent-window behavior. The settings protocol has no compare-and-swap revision token: two valid Options contexts can preview different snapshots and then save in last-write-wins order. A later cleanup still requires a fresh preflight and current-settings match, but one concurrent window can leave direct cleanup enabled when another appeared to disable it; the user may need to reopen Options to see which save won. Those cases remain in the disposable-profile matrix.

### Supply-chain or release contamination

**Attack/failure:** remote executable code, postinstall behavior, historical ZIPs, internal documents, secrets, caches, or undeclared runtime files enter a release.

**Controls:** zero runtime npm dependencies, `npm ci --ignore-scripts`, AST-based remote-capability scanning, full source-closure secret scanning, explicit runtime/source allowlists, symbolic-link rejection, staged canonical `dist/current/` promotion, complete runtime/source archive reinspection, exact path/byte/timestamp equivalence, checksums, SBOM, pinned CI actions, and a manual release gate evaluated after rebuild/verification. Version bumps reset browser/performance/accessibility results, and builds never rewrite those human evidence hashes. Remote attestation and repository settings remain unverified.

The fully proved expired-grant terminal sequence is ordered against worker death and storage uncertainty: prove the exact release/preservation disposition, durably commit and reread the nonce-bound canceled result, then retire its owned review and lease. A before-commit failure retains non-runnable recovery authority; a commit-then-reject can proceed only by rereading the identical terminal value.

## Non-goals and out-of-scope adversaries

The extension cannot remove or control server, ISP, DNS, VPN, firewall, enterprise, operating-system, synchronized, or browser-internal network-stack records. It is not a forensic-erasure tool, endpoint-security product, credential manager, anonymizer, or backup/recovery tool. A malicious browser, privileged local malware, compromised extension platform, or enterprise policy can defeat extension-level guarantees.

## Review triggers

Update this model before adding a permission, runtime dependency, network destination, cleanup category, broader target rule, MAIN-world code, remote service, analytics path, new export format, new browser, or automated publication capability.
