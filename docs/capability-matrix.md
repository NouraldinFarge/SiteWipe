# Capability matrix

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

“Implemented” below means a code path and automated contract exist. It does not mean every browser/version behavior has been validated. The final compatibility matrix must be narrowed to retained Chrome and Brave evidence.

## Core capabilities

| Surface                  | Intended scope and method                                                                                                   | Code status                                                                            | Browser evidence                    | Important limit                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ |
| Target normalization     | Full bundled ICANN+PRIVATE PSL or reviewed exact local origin                                                               | Implemented; automated corpus passes                                                   | Pending                             | Unknown suffix/public-suffix-only inputs fail closed                                 |
| Scope/impact preflight   | Read-only inspection, mandatory complete review, then recomputed session-scoped single-use approval in both modes           | Implemented; mutation-spy, tamper, retired-mode, and authorization-boundary tests pass | Pending                             | Browser state can change after preflight and final adapter revalidation              |
| Temporary site access    | Durable preflight lease preserves pre-existing patterns and reconciles only temporary patterns after terminal/restart paths | Implemented with fail-closed recovery tests                                            | Pending grant/crash/restart run     | Chrome may refuse or obscure removal; recovery state then remains pending            |
| Tabs                     | Query/audit/close exact target matches with a fresh pre-mutation re-read                                                    | Implemented                                                                            | Pending                             | A tab can still change during Chrome's asynchronous mutation                         |
| Cookies                  | Matching stores plus exposed partition keys and bounded probes                                                              | Implemented/partial by platform                                                        | Pending                             | Exact-origin cookies remain host-scoped; CHIPS visibility varies                     |
| Origin storage           | Guarded `browsingData.remove({origins})` allowlist                                                                          | Implemented                                                                            | Pending                             | Chrome's origin behavior varies by data type/store                                   |
| Live-page storage        | Isolated-world LocalStorage/sessionStorage/IDB/cache/SW/OPFS best effort                                                    | Implemented/partial                                                                    | Pending                             | Only accessible open frames; web API support varies                                  |
| History                  | Bounded searches, re-match, individual `deleteUrl`                                                                          | Implemented                                                                            | Pending                             | No persistent private history exposed                                                |
| Download records         | Bounded searches, re-match, `erase`                                                                                         | Implemented                                                                            | Pending                             | Only records Chrome exposes                                                          |
| Downloaded files         | Expert-only, preflight-bound completed IDs, execution revalidation, typed target confirmation                               | Implemented high-risk option                                                           | Pending                             | Irreversible and off by default; every run requires the exact confirmation           |
| Temporary request shield | DNR session rules in owned ID range                                                                                         | Implemented with recovery tests                                                        | Pending interruption run            | Browser-wide network-rule timing remains asynchronous                                |
| Verification             | Re-query cookies/tabs/history/download records with explicit evidence states                                                | Implemented                                                                            | Pending forced failure/residue runs | Best effort; not proof of complete erasure                                           |
| Reports                  | Central redaction, local SHA-256, expiry, exports                                                                           | Implemented                                                                            | Pending UI/export/restart run       | Checksum is not a signature; redaction is not anonymity                              |
| Cancellation and budgets | Monotonic cooperative checks plus run-wide duration/query/record ceilings                                                   | Implemented                                                                            | Pending                             | Does not roll back completed phases or abort an already-started Chrome call          |
| Cross-context messages   | Versioned/correlated envelopes, sender/payload validation, and response deadlines                                           | Implemented                                                                            | Pending stale-page/worker run       | Legacy envelope acceptance is transitional for already-open extension pages          |
| Incognito                | Browser-controlled spanning access                                                                                          | Implemented gate                                                                       | Pending enabled/disabled runs       | Extension cannot enable access; while enabled, completed reports are never persisted |

## Protected categories

| Category                              | Behavior                                               | Rationale                                                                    |
| ------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Passwords                             | Never requested or changed                             | No cleanup path and outside product boundary                                 |
| Passkeys/WebAuthn                     | Never requested or changed                             | Credential material is protected                                             |
| Bookmarks                             | Permission absent; never changed                       | Explicit exclusion                                                           |
| Browser Sync/account state            | APIs/storage absent; protected service targets blocked | Prevent account-wide effects                                                 |
| Autofill profiles                     | Never calls profile-wide `formData` removal            | Chrome does not expose a safe site-specific path                             |
| Payment methods                       | Same protected boundary as autofill                    | `formData` can affect payment data                                           |
| Site permission/content-setting rules | Preserved                                              | No safe arbitrary per-target deletion without overriding user/policy choices |

## Unsupported or manual-only residue

| Surface                                                                        | Status/reason                                                       |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Server/account/CDN logs                                                        | Outside extension and browser control                               |
| ISP, DNS provider, router, VPN, firewall, OS, antivirus, enterprise logs       | Outside extension APIs                                              |
| HSTS, Alt-Svc, DNS cache, TLS tickets, socket pools, NEL/reporting state       | No safe MV3 per-target cleanup API                                  |
| Recently closed sessions                                                       | No targeted forget API; `sessions` permission intentionally removed |
| Protocol handlers, FedCM/identity grants, Storage Access grants, device grants | Incomplete or no safe target-specific extension API                 |
| Favicons, Top Sites, omnibox suggestions                                       | May derive from many sources; no complete target-safe deletion API  |
| Browser permission/content-setting rules                                       | Manual browser settings review                                      |
| Synchronized or restored data                                                  | Can be recreated after local cleanup                                |

## Standard versus Expert

Standard mode keeps associated domains empty, local targets disabled unless separately configured, protected/PWA origin cleanup off, embedded-frame discovery off, expanded partition/exhaustive/recent/broad discovery off, on-disk deletion off, post-wipe blocking off, and optional tab/OPFS controls off. A fresh complete review is mandatory in both modes. Expert associated, local/IP, protected/PWA, preflight-bound file, persistent-shield, permission-requesting, private, and uncertain scope is displayed and must receive every applicable acknowledgement. The preflight binds target/settings/context/impact/file IDs; the message, approval, and authorization boundaries accept only `detailed_review`. Chrome/Brave may show its own target-access prompt after the final SiteWipe approval, but that prompt is not cleanup consent.

The detailed in-product matrix is generated from `src/shared/constants.js`; public wording must remain aligned with browser evidence and this document.
