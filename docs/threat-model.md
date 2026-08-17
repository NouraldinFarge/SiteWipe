# Threat model

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

Last reviewed: 2026-08-17. This model covers the reviewed local SiteWipe `1.11.19` candidate, not a future store-signed artifact or unrelated product using the same name.

## Security goals

1. A destructive operation stays inside the freshly authorized, normalized, preflight-bound scope; a complete per-run review is mandatory in Standard and Expert modes.
2. No browser-data mutation occurs before a fresh, context-bound approval is consumed.
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

| Boundary                           | Untrusted input                                                          | Required control                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| User input → scope model           | URLs, Unicode, ports, credentials, suffixes, associated groups           | Canonical parsing, PSL resolution, safe schemes, protected-target guard, fail closed                                                          |
| Extension page → service worker    | Message type, stale response, and payload                                | Version/correlation envelope, extension-origin sender check, exact schemas, size limits, timeouts, unknown-field rejection                    |
| Web page → injected script/message | Hostile page JavaScript and DOM                                          | Isolated execution world, internal target matcher, narrow cancellation-only message route                                                     |
| Stored state → runtime             | Corruption, old versions, manual tampering                               | Full approval recomputation, strict lease partition validation, schemas, serialized mutations, explicit transitions, safe defaults            |
| Runtime → Chrome APIs              | Differing API scope semantics and review-to-use races                    | Per-adapter guards, final origin/tab/file validation, run-wide budgets, bounded queries, no global/time-based browsing-data calls             |
| Runtime → DNR                      | Interrupted asynchronous rule mutation                                   | Reserved IDs, intent persisted first, full-range diagnostics, retain unknown state                                                            |
| Report → storage/export/support    | Browsing URLs, paths, API error text                                     | Central schema-aware and free-form redaction, serialized leak checks, refreshed checksum                                                      |
| Source → release artifact          | Unknown/symlinked files, stale ZIP, remote code, secrets, stale evidence | Explicit runtime/source closures, AST scan, staged canonical directory, archive reinspection, exact byte/timestamp parity, checksums and SBOM |

## Threat analysis

### Cross-tenant or lookalike over-deletion

**Attack/failure:** `alice.blogspot.com` is reduced to `blogspot.com`, a concatenated lookalike matches, or an associated target bypasses normalization.

**Controls:** the complete pinned PSL includes PRIVATE rules; matchers require exact/dot boundaries; exact origins retain scheme and port; associated items are normalized separately; the live-page function repeats the same boundary checks; unknown suffixes fail closed.

**Evidence:** official PSL corpus tests, named hosted-platform regressions, property tests, and a sibling-tenant invariant spanning origins, tabs, page scrub, cookies, history, downloads, DNR, and verification. Installed-browser fixture evidence remains pending.

### Destruction before meaningful consent

**Attack/failure:** an unrequested primary action, stale normalized target, forged quick/bypass message, replayed token, changed settings/window/private context, omitted Expert acknowledgement, stale page, or alternate message route starts deletion.

**Controls:** preflight inspection uses read APIs only and only one live approval record may exist. Both modes render the complete fresh target, associated scope, categories, impacts, unknowns, permission needs, retention, request-shield behavior, irreversible file effects, limitations, and verification boundary. Its explicit final approval requests only missing displayed host patterns and submits a versioned `detailed_review` message. Chrome/Brave may interpose its own permission prompt, but that prompt is not cleanup consent. The message schema, review validator, preflight consumer, and independent authorization module all reject other modes. Token consumption occurs before recovery or cleanup mutation and recomputes the normalized target, effective settings, associated scope, permission partition, completed-file IDs, impact evidence, context, and required acknowledgements. Every approval is random, single-use, session-scoped, expires after five minutes, and is bound to source window/private context/settings/target/impact. Associated, local, private, protected/PWA, file-removal, and other elevated scope require their displayed acknowledgements; on-disk deletion additionally requires typing the normalized target. Explicit origin plans, download records, and live tabs are revalidated immediately before mutation. Legacy bypass settings are dropped and bypass-era preflight records are invalidated by schema version.

**Residual risk:** browser data can change after review and final adapter revalidation; Chrome's asynchronous state can still race. A malicious local actor controlling the extension process or device can defeat UI consent. If the popup/worker stops after a permission grant but before cleanup submission, the new pattern can remain until approval expiry or maintenance next wakes; a durable lease preserves the recovery obligation across restart, but installed-browser grant/release/crash evidence remains pending. The former consent regression is closed in code under ADR 0009, while exact-artifact installed-browser evidence remains a release gate.

### Temporary permission ownership is lost or corrupted

**Attack/failure:** a service-worker/browser restart loses the session approval after Chrome grants host access, or malformed durable state causes SiteWipe to remove a grant that existed before preflight.

**Controls:** before any prompt, a local lease records the exact canonical requested patterns as a disjoint union of pre-existing and potentially temporary patterns. Live prepared leases are deferred until their review window expires. Completion, rejection, cancellation, reset, startup, and maintenance use strict `permissions.contains` checks and remove only temporary entries; the lease is forgotten only after every temporary pattern is proved absent. Broad wildcard-only patterns, protected-service scopes, invalid status/timestamps, and inconsistent partitions invalidate the lease before any permission call. An invalid record remains visible for manual recovery rather than being interpreted permissively.

**Residual risk:** Chrome can refuse permission removal or make permission state unavailable. In that case access and the recovery record can remain until a later retry or manual revocation. Installed Chrome/Brave restart evidence is still required.

### Compromised page falsifies cleanup

**Attack/failure:** page code replaces storage APIs or spoofs results when cleanup executes in `MAIN` world.

**Controls:** the former MAIN-world path is forcibly disabled regardless of migrated settings. Injection uses the isolated extension world and carries a self-contained matcher. Results remain best effort and are not treated as cryptographic proof.

### Browser API hangs or finishes after timeout

**Attack/failure:** an API times out, the service worker proceeds, and a late mutation makes the report inaccurate.

**Controls:** timeouts are labeled unknown, never ordinary zero/failure; verification uses explicit states; DNR recovery records survive uncertainty; normalized adapter outcomes expose attempted/succeeded/failed/timed-out/unknown/skipped/capped counts; final reports include errors/limitations. Run-wide duration/query/record budgets stop scheduling new work after their ceiling, and cancellation-check failures propagate instead of being interpreted as permission to continue. Operations that cannot be safely canceled are never promised canceled.

**Residual risk:** Chrome APIs generally do not expose abort handles. A timed-out underlying operation may complete later.

### Orphaned request shield

**Attack/failure:** worker termination occurs between DNR mutation and state update, leaving target requests blocked without visible recovery state.

**Controls:** recovery intent is persisted before install; rule IDs are restricted to `730000–730499`; clear paths remove the entire owned range; diagnostics must prove zero before forgetting; observed orphan rules reconstruct an unknown recovery record.

**Residual risk:** if both DNR inspection and local state are unavailable, the extension cannot prove shield state until a later browser wake or reload.

### Report or diagnostic privacy leak

**Attack/failure:** URL/path canaries survive inside free-form error labels, nested data, HTML/text exports, debug logs, or support bundles.

**Controls:** one central recursive redactor handles structured fields plus URL, host, IP, extension-ID, local/posix-path, secret-parameter, and probable-filename detectors; stable domain hashes are avoided; export transforms refresh SHA-256; adversarial serialization tests reject surviving canaries; debug/job/shield snapshots are scrubbed. Completed reports are never persisted while private-window access is enabled because affected private scope cannot be proven absent.

**Residual risk:** redaction is not anonymization. Unknown string formats, timestamps, counts, and contextual combinations may identify activity. Users must inspect exports before sharing.

### Message spoofing or malformed state

**Attack/failure:** another extension, a web page, oversized payload, unexpected field, or corrupted storage activates a privileged route.

**Controls:** the service worker validates every declared message type and sender. Requests and responses carry a protocol version and correlation ID; UI callers enforce bounded response deadlines. Target-page messages may only request cooperative cancellation. State schemas bound strings, arrays, IDs, timestamps, sizes, transitions, review content, and permission ownership. Serialized read-modify-write paths prevent report/settings/job/shield races, and a cancellation request is monotonic across progress writes.

### Supply-chain or release contamination

**Attack/failure:** remote executable code, postinstall behavior, historical ZIPs, internal documents, secrets, caches, or undeclared runtime files enter a release.

**Controls:** zero runtime npm dependencies, `npm ci --ignore-scripts`, AST-based remote-capability scanning, full source-closure secret scanning, explicit runtime/source allowlists, symbolic-link rejection, staged canonical `dist/current/` promotion, complete runtime/source archive reinspection, exact path/byte/timestamp equivalence, checksums, SBOM, pinned CI actions, and a manual release gate evaluated after rebuild/verification. Version bumps reset browser/performance/accessibility results, and builds never rewrite those human evidence hashes. Remote attestation and repository settings remain unverified.

## Non-goals and out-of-scope adversaries

The extension cannot remove or control server, ISP, DNS, VPN, firewall, enterprise, operating-system, synchronized, or browser-internal network-stack records. It is not a forensic-erasure tool, endpoint-security product, credential manager, anonymizer, or backup/recovery tool. A malicious browser, privileged local malware, compromised extension platform, or enterprise policy can defeat extension-level guarantees.

## Review triggers

Update this model before adding a permission, runtime dependency, network destination, cleanup category, broader target rule, MAIN-world code, remote service, analytics path, new export format, new browser, or automated publication capability.
