# Threat model

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

Last reviewed: 2026-08-21. This model covers the local working SiteWipe `1.11.46` candidate; its current complete validation, exact-artifact installed review, and exact-version owner/publication decisions remain pending. It does not cover a future store-signed artifact or unrelated product using the same name.

## Security goals

1. A destructive operation stays inside the freshly authorized, normalized, preflight-bound scope; detailed review is the default, and optional direct mode requires a separately confirmed saved setting in Standard or Expert.
2. No browser-data mutation occurs before a fresh, context-bound, single-use `detailed_review` or setting-derived `settings_direct` approval is consumed.
3. Passwords, passkeys, bookmarks, Sync/account state, autofill profiles, and payment methods remain outside all cleanup paths.
4. Extension-owned request blocking cannot be silently orphaned after interruption.
5. Failed, unavailable, or timed-out work is reported as uncertain rather than successful.
6. Locally retained reports minimize browsing-data exposure and expire as described.
7. Untrusted pages, messages, imports, stored records, and generated artifacts cannot broaden authority.

## Assets

- unrelated sites' cookies, storage, tabs, history, and download records;
- downloaded files and other irreplaceable local data;
- protected credential, account, autofill, payment, and bookmark stores;
- private-window browsing details;
- the accuracy of scope, progress, verification, and limitation reports;
- browser availability after temporary DNR rules;
- release integrity, source/package equivalence, and third-party provenance.

## Trust boundaries

| Boundary                           | Untrusted input                                                               | Required control                                                                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User input → scope model           | URLs, Unicode, ports, credentials, suffixes, associated groups                | Canonical parsing, PSL resolution, safe schemes, protected-target guard, fail closed                                                                                                                                                                                            |
| Extension page → service worker    | Message type, stale response, and payload                                     | Version/correlation envelope, extension-origin sender check, exact schemas, size limits, timeouts, unknown-field rejection                                                                                                                                                      |
| Web page → injected script/message | Hostile page JavaScript and DOM                                               | Isolated execution world, internal target matcher, narrow cancellation-only message route                                                                                                                                                                                       |
| Stored state/import → runtime      | Corruption, old versions, manual tampering, oversized/foreign settings backup | Size/schema/app/version/key/value validation, explicit import preview/confirmation including direct-mode risk, complete preflight-snapshot reconstruction, current-settings/private-access revalidation, strict lease/inventory validation, serialized mutations, safe defaults |
| Runtime → Chrome APIs              | Differing API scope semantics and review-to-use races                         | Per-adapter target/private-scope guards, final origin/tab/download-identity validation, run-wide budgets, bounded queries, no global/time-based browsing-data calls                                                                                                             |
| Runtime → DNR                      | Interrupted or late asynchronous rule mutation                                | Reserved IDs, intent persisted first, full-range diagnostics, pending-install settlement tracking, and retained unknown state                                                                                                                                                   |
| Report → storage/export/support    | Browsing URLs, paths, API error text                                          | Central schema-aware and free-form redaction, serialized leak checks, refreshed checksum                                                                                                                                                                                        |
| Source → release artifact          | Unknown/symlinked files, stale ZIP, remote code, secrets, stale evidence      | Explicit runtime/source closures, AST scan, staged canonical directory, archive reinspection, exact byte/timestamp parity, checksums and SBOM                                                                                                                                   |

## Threat analysis

### Cross-tenant or lookalike over-deletion

**Attack/failure:** `alice.blogspot.com` is reduced to `blogspot.com`, a concatenated lookalike matches, or an associated target bypasses normalization.

**Controls:** the complete pinned PSL includes PRIVATE rules; matchers require exact/dot boundaries; exact origins retain scheme and port; associated items are normalized separately; the live-page function repeats the same boundary checks; unknown suffixes fail closed.

**Evidence:** official PSL corpus tests, named hosted-platform regressions, property tests, and a sibling-tenant invariant spanning origins, tabs, page scrub, cookies, history, downloads, DNR, and verification. Installed-browser fixture evidence remains pending.

### Destruction before meaningful consent

**Attack/failure:** an unrequested primary action, caller-provided skip flag, raw/unbound direct message, replayed token, changed settings/window/private context, forged acknowledgement or file list, stale page, or alternate message route starts deletion.

**Controls:** preflight inspection uses read APIs only and only one live approval record may exist. Detailed review is the default in Standard and Expert and renders the complete fresh target, cleanup mode, associated scope, categories, impacts, unknowns, exact required site-access patterns, retention, request-shield behavior, irreversible file effects, limitations, and verification boundary. Its final approval submits `detailed_review` after any missing normal-window exact access is granted.

The default-off `skipCleanupReview` setting can be enabled only after an explicit Settings warning. When true, SiteWipe prepares the same hidden read-only snapshot and durable `prompt_pending` permission lease before enabling **Clean now**. That one SiteWipe activation requests missing normal-window access first when necessary and then submits `settings_direct`; a native prompt may add a browser-controlled interaction. Private-source direct cleanup requires **Allow in incognito** and pre-existing exact target access before preflight. The message schema exposes no caller skip field or raw direct route. It requires the caller mode to equal the stored prepared mode, and direct payloads must explicitly claim false per-run acknowledgements plus an empty file phrase.

Token consumption occurs before recovery or cleanup mutation and re-reads current settings/private-access state, resolves target/associated scope again, reconstructs the complete impact/access/permission-lease/file-ID snapshot, and exact-compares context and mode-appropriate acknowledgement claims. Every approval is random, single-use, session-scoped, expires after five minutes, and is bound to source window/private context/settings/target/impact. A settings change invalidates prepared authority. A separate conservative 30-minute `prompt_pending` recovery window keeps ownership after a possible native prompt until explicit denial/abandonment or strict reconciliation proves temporary access absent. Detailed mode requires associated/local/protected/file acknowledgements and the typed file phrase; direct mode intentionally skips them under saved authorization while retaining preflight file IDs. Explicit origin plans, live download identities, and tabs/private scope are revalidated immediately before mutation. Legacy quick/bypass modes and older schemas remain invalid.

**Residual risk:** direct mode intentionally removes per-run visibility and acknowledgement, so a settings choice may remain enabled when the user later changes Expert effects. Browser data can change after preflight and final adapter revalidation; Chrome's asynchronous state can still race. A malicious local actor controlling the extension process or device can defeat UI consent. If the popup/worker stops after a permission grant but before cleanup submission, the new pattern can remain through the conservative prompt-pending recovery window or longer if Chrome refuses removal; the durable lease preserves the obligation across restart. Exact-artifact detailed/direct/native-prompt/incognito evidence remains a release gate under ADR 0011.

### Private-window authority expands after preflight

**Attack/failure:** a run preflighted with normal-window scope later consults the browser's live global incognito setting and begins discovering, injecting into, changing, closing, or verifying private tabs that were never bound.

**Controls:** consumption requires the browser private-access state to equal the preflight-bound value. The consumed approval carries that immutable value through scope discovery, tab-state changes, page scrub, progress overlay, tab closure, and verification. Each tab is filtered or re-read against both target and bound private scope. A private-source direct run requires exact target access before preflight so no missing private target pattern is requested or written to durable permission-lease state. False→true, true→false, discovery, navigation, injection, progress, closure, and verification regressions exercise the boundary.

**Residual risk:** installed Chrome/Brave incognito spanning behavior, window races, extension reload, and native extension-settings changes remain pending exact-artifact tests. Browser state may still change after the final re-read and before an asynchronous mutation finishes.

### Temporary permission ownership is lost or corrupted

**Attack/failure:** a service-worker/browser restart loses the session approval after Chrome grants host access, or malformed durable state causes SiteWipe to remove a grant that existed before preflight.

**Controls:** preflight queries `permissions.getAll()`, canonicalizes the returned origins, and retains only exact required and relevant broader patterns that cover the preflight target; unrelated exact/wildcard hostnames are omitted. It derives required patterns covered by broader access and truthful all-site status, displays broader access in detailed mode, and binds the minimized inventory to the detailed review or direct report. Before any normal-window prompt, a local lease records only exact canonical requested patterns as a disjoint union of pre-existing and potentially temporary patterns and enters `prompt_pending`. Broader user-controlled grants never enter removal calls. Private-source cleanup refuses to persist missing target patterns and requires exact access before preflight. A prepared token remains at most five minutes and is never extended on popup reopen; the separate conservative prompt-pending recovery obligation remains for up to 30 minutes unless explicit denial/abandonment or strict absence proof settles it sooner. Completion, rejection, cancellation, reset, startup, and maintenance use strict `permissions.contains` checks and remove only temporary entries; the lease is forgotten only after every temporary pattern is proved absent. If settings invalidate the popup after a grant and the worker proves no cleanup job began, the popup attempts to release only origins explicitly classified temporary by that preflight; ambiguous submissions preserve access and surface manual review. Broad wildcard-only lease entries, protected-service scopes, invalid status/timestamps, inconsistent partitions, or derived inventory tampering invalidate the record before any permission call. An invalid record remains visible for manual recovery rather than being interpreted permissively.

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

**Controls:** the service worker validates every declared message type and sender. Requests and responses carry a protocol version and correlation ID; UI callers enforce bounded response deadlines. Target-page messages may only request cooperative cancellation. State schemas bound strings, arrays, IDs, timestamps, sizes, transitions, review content, and permission ownership. Serialized read-modify-write paths prevent report/settings/job/shield races, and a cancellation request is monotonic across progress writes.

### Stale or hostile Settings operations broaden authority during cleanup

**Attack/failure:** a stale full-form Options save, oversized/foreign backup, mode switch, reset, shield repair, or manual maintenance runs during an active cleanup or silently revives an Expert-only optional permission.

**Controls:** background settings/reset/shield/maintenance/local-reset routes reject a live cleanup, with disabled/ARIA-explained Options controls as usability defense in depth. Settings backups are size-bounded, SiteWipe schema/app/version checked, allowlisted, value-validated, summarized, and explicitly confirmed before one background save. Standard mode, entry into Expert, feature disable, and reset persist embedded-frame discovery off and remove `webNavigation`; enabling it requires a later explicit Expert gesture.

**Residual risk:** Options source contracts do not prove installed focus, stale-tab, native prompt, imported-file, or concurrent-window behavior. The settings protocol has no compare-and-swap revision token: two valid Options contexts can preview different snapshots and then save in last-write-wins order. A later cleanup still requires a fresh preflight and current-settings match, but one concurrent window can leave direct cleanup enabled when another appeared to disable it; the user may need to reopen Options to see which save won. Those cases remain in the disposable-profile matrix.

### Supply-chain or release contamination

**Attack/failure:** remote executable code, postinstall behavior, historical ZIPs, internal documents, secrets, caches, or undeclared runtime files enter a release.

**Controls:** zero runtime npm dependencies, `npm ci --ignore-scripts`, AST-based remote-capability scanning, full source-closure secret scanning, explicit runtime/source allowlists, symbolic-link rejection, staged canonical `dist/current/` promotion, complete runtime/source archive reinspection, exact path/byte/timestamp equivalence, checksums, SBOM, pinned CI actions, and a manual release gate evaluated after rebuild/verification. Version bumps reset browser/performance/accessibility results, and builds never rewrite those human evidence hashes. Remote attestation and repository settings remain unverified.

## Non-goals and out-of-scope adversaries

The extension cannot remove or control server, ISP, DNS, VPN, firewall, enterprise, operating-system, synchronized, or browser-internal network-stack records. It is not a forensic-erasure tool, endpoint-security product, credential manager, anonymizer, or backup/recovery tool. A malicious browser, privileged local malware, compromised extension platform, or enterprise policy can defeat extension-level guarantees.

## Review triggers

Update this model before adding a permission, runtime dependency, network destination, cleanup category, broader target rule, MAIN-world code, remote service, analytics path, new export format, new browser, or automated publication capability.
