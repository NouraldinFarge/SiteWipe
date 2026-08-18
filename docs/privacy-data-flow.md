# Privacy data flow

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

This document supplements [`PRIVACY.md`](../PRIVACY.md) with implementation-level flows. It does not replace a future hosted privacy policy.

## Runtime flow

```mermaid
flowchart TD
  Input["Entered target"] --> Normalize["Local parser + bundled PSL"]
  Normalize --> Impact["Read-only Chrome API inspection"]
  Impact --> Lease["Durable requested/pre-existing/temporary access lease"]
  Lease --> Review["Mandatory complete scope and impact review"]
  Review -->|cancel| SessionDelete["Delete session approval + reconcile lease"]
  Review -->|explicit final approval| Permission["Request only missing reviewed target patterns"]
  Permission --> Contract["Validate detailed-review message; native target prompt is not consent"]
  Contract --> SessionConsume["Consume single-use session approval"]
  SessionConsume --> Authorization["Recompute snapshot + independent reviewed authorization"]
  Authorization --> LeaseActive["Mark validated lease active"]
  LeaseActive --> Job["Scrubbed recovery job in local storage"]
  Job --> Browser["Target-scoped browser API operations"]
  Browser --> Evidence["Counts, explicit states, bounded samples/errors"]
  Browser --> LeaseRelease["Release temporary access; retain lease until absence proved"]
  Evidence --> Redact["Central recursive redaction"]
  Redact --> Digest["SHA-256 content checksum"]
  Digest --> PrivateGate{"Private-window access enabled or scope observed?"}
  PrivateGate -->|no| Latest["Latest report: 30 min default"]
  PrivateGate -->|yes| UI
  Digest --> UI["Popup / side-panel response"]
  Latest --> Forget["Alarm, on-read expiry, or Forget now"]
```

No project-controlled server exists in this path. The developer-only PSL update script is outside the runtime and contacts only reviewed upstream sources when explicitly run.

## Data inventory

| Data                      | Source                                     | Purpose                                                                                              | Storage/default                                                                           | Sharing                            |
| ------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| Entered/normalized target | User / active tab                          | Determine approved scope and display the normalized target                                           | Raw input is not retained in the final report; approval is short-lived in session storage | None automatically                 |
| Impact candidates         | Tabs, cookies, history, downloads, origins | Show the complete per-run review and bind exact scope/settings/context/impact/file IDs in both modes | Approval record in session storage for up to five minutes                                 | None automatically                 |
| Permission lease          | Preflight-requested host patterns          | Preserve pre-existing grants and recover only access that may be temporary                           | Minimal local record until every temporary pattern is proved absent                       | None automatically                 |
| Active job                | Runtime progress                           | Cancellation/interruption visibility                                                                 | Scrubbed local record until cleared/replaced                                              | None automatically                 |
| Active shield             | DNR rules and target                       | Clear/recover extension-owned rules                                                                  | Scrubbed local record until proven cleared or approved expiry                             | None automatically                 |
| Report                    | Runtime operations and verification        | Local evidence and troubleshooting                                                                   | Redacted latest report, 30 minutes and history off only while private access is disabled  | Only through explicit local export |
| Report history            | Prior reports                              | Optional comparison                                                                                  | Opt-in, at most 10 and configured retention                                               | Only through explicit local export |
| Debug summaries           | Runtime                                    | Opt-in troubleshooting                                                                               | Off by default, bounded to 100, centrally scrubbed                                        | Only if user copies/exports it     |
| Settings                  | User                                       | Configure behavior                                                                                   | Local until reset/uninstall                                                               | Explicit local backup only         |
| Maintenance snapshot      | Extension                                  | Explain expiry/recovery work                                                                         | Scrubbed local latest snapshot                                                            | None automatically                 |

## Redaction flow

The central redactor is used for persisted reports, redacted JSON/text/HTML exports, bulk history, troubleshooting summaries, privacy migration, and debug/support values. It:

1. clones serializable input;
2. replaces schema-sensitive targets, URLs, origins, hosts, domains, referrers, paths, filenames, and related arrays;
3. scans every string for URL/domain/IP/email/extension-ID/path/secret-parameter/probable-filename patterns;
4. removes any prior checksum and computes SHA-256 over the transformed content;
5. serializes the result and rejects known sensitive patterns or supplied test canaries.

The candidate intentionally does not emit stable target hashes. Domains have low entropy, so an unsalted stable digest is susceptible to dictionary recovery. Redaction reduces accidental disclosure but cannot guarantee anonymity.

## Full-detail opt-in

Turning report redaction off is a settings opt-in that allows full detail in local report storage and the immediate result. Full JSON export requires a separate warning. The interface recommends redacted exports; users remain responsible for reviewing the destination and content.

## Private-window flow

The browser controls private access. A private-origin request without that access is rejected. Whenever the browser reports private access enabled, a scrubbed recovery job/shield may exist locally because MV3 interruption must remain recoverable, but the completed report is not persisted—even when the source window is normal—because the extension cannot prove private scope was unaffected. The immediate result follows the redaction setting. The privacy policy must not imply that incognito prevents browser, OS, employer, network, or website retention.

## Deletion and retention controls

- **Forget report now** clears the latest report immediately.
- **Delete stored report history** clears only prior-history entries and preserves the separately retained latest report; **Forget report now** removes that latest item and its duplicate history entry, if present.
- Scheduled maintenance and every report read enforce latest-report expiry.
- Reset clears settings, reports, logs, maintenance state, and finished job state; shield and temporary-access recovery records are retained whenever Chrome cannot prove the owned DNR/permission state empty.
- Uninstall asks the browser to remove extension-local storage, subject to browser behavior.

## Data-protection limits

The extension cannot control Chrome's own diagnostic logging, Sync, backups, disk remnants, other extensions, enterprise tooling, the operating system, networks, or websites. A content checksum detects content changes only; it is not encryption, authentication, a deletion proof, or an integrity guarantee against a malicious local actor.
