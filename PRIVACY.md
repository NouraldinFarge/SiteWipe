# Privacy Policy

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

This policy describes the public-source prerelease under the owner-approved custom identity SiteWipe `1.11.46`. The first-party project source is MIT-licensed, and the repository is independently reachable at [`NouraldinFarge/SiteWipe`](https://github.com/NouraldinFarge/SiteWipe). The default branch still hosts an older policy until this exact candidate is proposed and reviewed, so that repository copy must not yet be cited as the hosted policy for this version. Source availability does not approve a binary release or store submission, and this policy must not be represented as a Chrome Web Store policy until the exact artifact, installed evidence, live disclosures, and submission are separately approved.

Last reviewed: 2026-08-21. Candidate-specific automated, installed-browser, and hosted-policy verification remains pending in the active evidence records.

## Summary

The extension is designed to perform its work locally through browser extension APIs. The reviewed runtime contains no developer-controlled network request, analytics, advertising, telemetry, or remote executable-code path. It does not sell or transmit browsing data to a project server because no project server is part of the runtime.

“Local” does not mean “nothing is stored.” The extension stores settings and recovery state locally and, by default, temporarily stores one redacted latest report for 30 minutes. Browser APIs and the websites themselves may separately process or recreate data outside the extension's control.

## Data the extension reads

Only after user interaction and the applicable browser permissions, the extension may read:

- the active tab URL/title and matching open-tab metadata;
- cookies available for the approved target host patterns, including exposed partition metadata;
- matching browser-history entries;
- matching download-list records, including a filename when Chrome exposes it for review of optional file deletion;
- origin and frame URLs used to constrain storage cleanup;
- extension-owned settings, reports, job state, request-shield state, diagnostics, and a privacy-minimized subset of currently granted host-permission patterns relevant to exact/broader reviewed-target access disclosure;
- incognito-access status, without enabling that browser-controlled setting;
- live-page storage metadata and permission states on matching, accessible pages through an isolated extension world.

The extension does not request access to bookmarks, passwords, passkeys, identity accounts, or browser Sync storage. It intentionally does not call profile-wide form-data deletion because that can affect autofill profiles and payment methods.

## Data the extension changes

Every cleanup begins with a deterministic read-only impact and host-access preflight. Detailed review is enabled by default in Standard and Expert mode. It displays the active mode, entered and normalized target, subdomain and associated-target scope, normal/private-window context, selected and unsupported categories, known and unknown impact counts, exact required target-access patterns, request shielding, report retention, downloaded-file effects, limitations, and verification boundary, and then requires a separate final approval.

The user may explicitly enable **Skip detailed cleanup review completely** in Settings after confirming a warning about Standard, Expert, irreversible file, associated/protected, private-window, and native-permission-prompt consequences. In that opt-in mode, entering or selecting a valid target starts the same fresh preflight without displaying the detailed screen. SiteWipe binds the exact target, effective settings, associated targets, source window/private state, current incognito-access state, relevant host-permission inventory, complete impact snapshot, exact downloaded-file candidate IDs, and durable prompt-pending permission lease before **Clean now** is enabled. One **Clean now** action then submits the short-lived `settings_direct` authorization, after any required native normal-window prompt. SiteWipe re-reads and reconstructs the bound values when consuming the single-use record; any stale, changed, replayed, malformed, or mismatched authority is discarded before mutation. The cleanup report truthfully says that saved direct authorization was used and that no per-run scope review occurred.

A Chrome/Brave target-access prompt may still appear after the detailed approval or **Clean now** for a normal-source run. That browser prompt is a separate platform control, so the direct option means one SiteWipe cleanup action rather than a guarantee of one total interaction.

Only after the single-use preflight-bound authorization is consumed may the extension attempt to change browser-accessible data for the authorized scope: cookies, origin storage/cache, matching tabs, matching history URLs, matching download-list records, live-page state, and, when private-window scope is included, temporary extension-owned request-shield rules. The preflight-bound private-window value is immutable authority for the run; normal-only authorization does not expand into private tabs, frames, overlays, tab changes, or verification if browser settings change. Because shared DNR session rules cannot be bound to normal windows only, SiteWipe installs no temporary or post-wipe request shield for a normal-only run; the detailed review or direct-run report discloses that skip and the resulting recreation risk. Downloaded-file deletion is off by default, available only in Expert mode, and bound to completed download IDs captured by the read-only preflight. Detailed mode separately confirms it by typing the normalized target. Opted-in direct mode intentionally skips that per-run phrase, but it does not skip the exact file-ID binding or immediate irreversible-operation guard. Immediately before removal, an exact-ID browser query must prove one unchanged target-matched, complete, present, approved filename/URL/referrer identity. A changed, missing, duplicate, incomplete, or non-preflight-bound record is not authorized, and uncertainty preserves both file and record.

## Local extension storage

The following records use `chrome.storage.local` unless noted:

| Record           | Purpose                                                                                  | Default retention                                                      |
| ---------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Settings         | User choices and privacy-migration markers                                               | Until reset or extension removal                                       |
| Latest report    | Immediate local result view                                                              | Redacted; 30 minutes only when private-window access is disabled       |
| Report history   | Optional prior results                                                                   | Disabled by default; when enabled, bounded count and retention         |
| Active job       | Progress, cancellation, interruption recovery                                            | Until terminal state is cleared/replaced                               |
| Active shield    | Recovery for SiteWipe-owned DNR session rules                                            | Until diagnostics prove rules cleared, or an approved post-wipe expiry |
| Permission lease | Exact preflight-requested patterns and their pre-existing/temporary classification       | Until strict browser checks prove every temporary pattern absent       |
| Last maintenance | Local audit of expiry/recovery work                                                      | Until reset/replaced                                                   |
| Debug log        | Troubleshooting summaries                                                                | Disabled by default; bounded and always centrally scrubbed             |
| Cleanup approval | Short-lived, single-use preflight-bound `detailed_review` or `settings_direct` authority | `chrome.storage.session`; consumed, canceled, abandoned, or expired    |

The latest report expires through both scheduled maintenance and on-read checks, covering service-worker suspension and later browser wake-up. **Forget report now** removes the latest report immediately and removes the same report from optional history. **Delete stored report history** removes prior-history entries but deliberately preserves the separately retained latest report; the UI states this distinction. Resetting extension-local state does not intentionally delete website data; if Chrome cannot prove the extension-owned DNR range or temporary host access empty, the corresponding recovery record is retained instead of being falsely forgotten.

Preflight inspects currently granted host patterns but retains only exact required and relevant broader/all-site pre-existing access that covers the preflight target; unrelated exact or wildcard hostnames are omitted. This lets the detailed review and direct-run report disclose existing capability without retaining the browser's full host-access list. Broader patterns are user-controlled, do not authorize broader cleanup, and are never passed to automatic removal. For normal-window cleanup, the permission lease is written before any target-access prompt can appear and never contains the raw path or query from the entered URL. It accepts only canonical preflight-generated exact web patterns and preserves each pattern that was already available. Its `prompt_pending` recovery state is conservatively retained for up to 30 minutes unless explicit denial/abandonment or earlier strict reconciliation proves temporary access absent; this prevents a late native grant from outliving the recovery obligation and is not a promise about prompt duration. A private-source cleanup must already have exact target access before preflight; a missing private target pattern is neither requested nor persisted to a durable lease. Completion, failure, cancellation, abandonment, expiry, restart maintenance, and local reset retry removal only for exact patterns classified as temporary. If settings invalidate prepared authority after a native grant and the worker proves no cleanup job began, the popup attempts to release only preflight-classified temporary origins. An ambiguous submission does not cause speculative removal. If Chrome/Brave refuses removal or its state cannot be verified, the lease remains visible as recovery pending until a later retry proves absence or the user revokes access manually.

Whenever private/incognito access is enabled, completed reports are not persisted because the extension cannot prove that affected private scope was absent. The browser controls whether the extension may access private windows.

## Report redaction and checksums

Redaction is on by default. The centralized redactor:

- omits or replaces structured URL, origin, host, domain, path, filename, referrer, associated-target, and input fields;
- scans all free-form strings for URLs, domain names, local paths, extension IDs, email addresses, IP addresses, sensitive parameters, and probable filenames;
- recursively handles nested arrays and objects;
- recomputes a SHA-256 content checksum after transformation;
- rejects a redacted serialization when adversarial canary checks detect a remaining sensitive pattern.

Stable domain hashes are deliberately not used: low-entropy domain hashes are vulnerable to dictionary attacks. Redaction is risk reduction, not an anonymity guarantee; context, counts, timestamps, or an unknown format could still be identifying. Review every export before sharing it.

The report checksum detects content mismatch. It is not a signature, authentication, notarization, or proof that cleanup was complete.

Turning redaction off is an informed opt-in for local full-detail report storage. The privacy settings shown and approved for a cleanup control persistence for that run; changing settings later cannot silently retain an unredacted/history copy when the reviewed snapshot required redaction and no history. Full JSON exports require an additional warning/confirmation. Text, HTML, troubleshooting, and explicitly redacted exports use the central redaction pipeline.

## Network behavior

The extension runtime is designed without developer-controlled network calls and the release scanner rejects common remote-code and network primitives. Websites, Chrome, Brave, extensions, enterprise software, DNS resolvers, and operating-system components may still make their own network requests. A temporary DNR shield may block preflight-bound target requests while cleanup runs; that local browser rule is not a network transmission to this project.

The developer-only Public Suffix List update script can access the upstream PSL during a reviewed source update. The shipped extension bundles a pinned snapshot and never downloads PSL data at runtime.

## Private windows

Private/incognito access is optional and controlled in the browser's extension settings. The extension cannot enable it. If a cleanup starts from a private tab without **Allow in incognito** or without exact target access before preflight, the operation is blocked. The private-source direct path does not request that missing access. A private-access state change after preparation invalidates the token; once consumed, the preflight-bound value constrains every tab/frame operation. Whenever private-window access is enabled, the completed report is returned only to the current extension view and is not saved locally because the extension cannot prove that private scope was unaffected.

Private browsing does not prevent websites, networks, employers, operating systems, or other software from retaining data.

## User controls

Users can:

- decline or revoke target-specific site access;
- keep the default detailed review and inspect the complete target, scope, categories, impacts, permissions, retention, limitations, and high-risk effects before each Standard or Expert cleanup;
- explicitly opt in or out of **Skip detailed cleanup review completely** after a Settings warning; when enabled, one SiteWipe action uses saved authorization and a hidden fresh preflight in either mode;
- cancel a pending detailed review, or abandon a direct preflight/native prompt, without creating a cleanup job or request shield;
- request cooperative cancellation between cleanup phases;
- keep report history disabled;
- forget the latest report immediately;
- clear report history and debug summaries;
- run maintenance and inspect extension-owned shield diagnostics;
- reset extension-local state without requesting website-data deletion;
- export and import only an allowlisted, size-bounded SiteWipe settings backup; imports show recognized changes and privacy/destructive risks for confirmation before saving and do not import reports, jobs, shields, or browser website data;
- uninstall the extension to remove its local extension storage, subject to browser behavior.

## Data outside this extension's control

The extension cannot promise removal of server logs, account records, ISP/DNS/VPN/firewall/enterprise logs, operating-system artifacts, synchronized state, password/passkey stores, bookmarks, browser account state, browser-network-stack caches without target-safe APIs, or data that Chrome does not expose. A website or browser feature may recreate data after cleanup.

## Contact and policy changes

A public repository copy and confidential GitHub vulnerability-reporting route exist. A stable hosted URL containing this exact candidate policy, plus a maintained non-security contact route, still need to be recorded before any binary or store submission. The owner must then review that hosted policy against the exact signed artifact and store disclosure answers.

Security-sensitive reports must follow [`SECURITY.md`](./SECURITY.md) and must not include unredacted browsing data in a public issue.
