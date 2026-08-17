# Privacy Policy

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

This policy describes the current local candidate under the owner-approved custom identity SiteWipe `1.11.19`. The owner selected MIT for the first-party project source and authorized a private staging repository. A public GitHub Gist hosts this policy to provide a stable disclosure and non-sensitive contact page. Hosting the policy does not approve this candidate for public release or store submission, and it must not be represented as a Chrome Web Store policy until the exact public version, installed evidence, live disclosures, and publication are separately approved.

Last reviewed: 2026-08-17.

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
- extension-owned settings, reports, job state, request-shield state, and diagnostics;
- incognito-access status, without enabling that browser-controlled setting;
- live-page storage metadata and permission states on matching, accessible pages through an isolated extension world.

The extension does not request access to bookmarks, passwords, passkeys, identity accounts, or browser Sync storage. It intentionally does not call profile-wide form-data deletion because that can affect autofill profiles and payment methods.

## Data the extension changes

After a deterministic read-only impact preflight, the extension displays a fresh, complete scope-and-impact review. Standard and Expert mode both require the user to activate the final approval shown with that review before any cleanup message is accepted. The review includes the entered and normalized target, subdomain and associated-target scope, normal/private-window context, selected and unsupported categories, known and unknown impact counts, temporary host access, request shielding, report retention, downloaded-file effects, limitations, and the verification boundary. A Chrome/Brave target-access prompt may still appear after that approval, but the browser prompt is not cleanup consent and cannot substitute for SiteWipe's review.

Only after the single-use reviewed approval is consumed may the extension attempt to change browser-accessible data for the approved scope: cookies, origin storage/cache, matching tabs, matching history URLs, matching download-list records, live-page state, and temporary extension-owned request-shield rules. Downloaded-file deletion is off by default, available only in Expert mode, bound to completed download IDs captured by the read-only preflight, freshly revalidated, and separately confirmed by typing the normalized target. A changed, new, incomplete, or non-preflight-bound download is not authorized for file removal.

## Local extension storage

The following records use `chrome.storage.local` unless noted:

| Record           | Purpose                                                                            | Default retention                                                      |
| ---------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Settings         | User choices and privacy-migration markers                                         | Until reset or extension removal                                       |
| Latest report    | Immediate local result view                                                        | Redacted; 30 minutes only when private-window access is disabled       |
| Report history   | Optional prior results                                                             | Disabled by default; when enabled, bounded count and retention         |
| Active job       | Progress, cancellation, interruption recovery                                      | Until terminal state is cleared/replaced                               |
| Active shield    | Recovery for SiteWipe-owned DNR session rules                                      | Until diagnostics prove rules cleared, or an approved post-wipe expiry |
| Permission lease | Exact preflight-requested patterns and their pre-existing/temporary classification | Until strict browser checks prove every temporary pattern absent       |
| Last maintenance | Local audit of expiry/recovery work                                                | Until reset/replaced                                                   |
| Debug log        | Troubleshooting summaries                                                          | Disabled by default; bounded and always centrally scrubbed             |
| Cleanup approval | Short-lived, single-use destructive approval                                       | `chrome.storage.session`; consumed, canceled, or expired               |

The latest report expires through both scheduled maintenance and on-read checks, covering service-worker suspension and later browser wake-up. **Forget report now** removes the latest report immediately and removes the same report from optional history. **Delete stored report history** removes prior-history entries but deliberately preserves the separately retained latest report; the UI states this distinction. Resetting extension-local state does not intentionally delete website data; if Chrome cannot prove the extension-owned DNR range or temporary host access empty, the corresponding recovery record is retained instead of being falsely forgotten.

The permission lease is written before any target-access prompt can appear and never contains the raw path or query from the entered URL. It accepts only canonical preflight-generated web patterns and preserves each pattern that was already available. Completion, failure, cancellation, expiry, restart maintenance, and local reset retry removal only for patterns classified as temporary. If Chrome/Brave refuses removal or its state cannot be verified, the lease remains visible as recovery pending until a later retry proves absence or the user revokes access manually.

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

Turning redaction off is an informed opt-in for local full-detail report storage. Full JSON exports require an additional warning/confirmation. Text, HTML, troubleshooting, and explicitly redacted exports use the central redaction pipeline.

## Network behavior

The extension runtime is designed without developer-controlled network calls and the release scanner rejects common remote-code and network primitives. Websites, Chrome, Brave, extensions, enterprise software, DNS resolvers, and operating-system components may still make their own network requests. A temporary DNR shield may block preflight-bound target requests while cleanup runs; that local browser rule is not a network transmission to this project.

The developer-only Public Suffix List update script can access the upstream PSL during a reviewed source update. The shipped extension bundles a pinned snapshot and never downloads PSL data at runtime.

## Private windows

Private/incognito access is optional and controlled in the browser's extension settings. The extension cannot enable it. If a cleanup starts from a private tab without access, the operation is blocked. Whenever private-window access is enabled, the completed report is returned only to the current extension view and is not saved locally because the extension cannot prove that private scope was unaffected.

Private browsing does not prevent websites, networks, employers, operating systems, or other software from retaining data.

## User controls

Users can:

- decline or revoke target-specific site access;
- review the complete target, scope, categories, impacts, permissions, retention, limitations, and high-risk effects before every Standard or Expert cleanup;
- cancel a pending review without creating a cleanup job or request shield;
- request cooperative cancellation between cleanup phases;
- keep report history disabled;
- forget the latest report immediately;
- clear report history and debug summaries;
- run maintenance and inspect extension-owned shield diagnostics;
- reset extension-local state without requesting website-data deletion;
- uninstall the extension to remove its local extension storage, subject to browser behavior.

## Data outside this extension's control

The extension cannot promise removal of server logs, account records, ISP/DNS/VPN/firewall/enterprise logs, operating-system artifacts, synchronized state, password/passkey stores, bookmarks, browser account state, browser-network-stack caches without target-safe APIs, or data that Chrome does not expose. A website or browser feature may recreate data after cleanup.

## Contact and policy changes

For general privacy questions, use a non-sensitive comment on the public GitHub Gist that hosts this policy. Do not put browsing history, cookies, tokens, local paths, filenames, extension IDs, private-window activity, or vulnerability details in a Gist comment or public issue.

Confidential security reports must use [GitHub Private Vulnerability Reporting](https://github.com/NouraldinFarge/SiteWipe/security/advisories/new) after that route has been enabled and independently verified during the separately authorized public-repository transition. Until the confidential route works, retain a sensitive report locally and notify the owner only through a private channel the owner explicitly supplies; do not guess an email address.

The hosted policy must be reviewed again against the exact approved public artifact and store disclosure answers before any browser-store submission. Security-sensitive reports must also follow the repository's [security policy](https://github.com/NouraldinFarge/SiteWipe/blob/main/SECURITY.md).
