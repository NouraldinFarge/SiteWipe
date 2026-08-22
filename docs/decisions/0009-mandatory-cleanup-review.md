# ADR 0009: Require a complete per-run cleanup review

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Superseded in part by [ADR 0011](./0011-optional-direct-cleanup.md); retained as the default detailed-review contract and historical decision
- Date: 2026-08-17
- Safety reconciliation: 2026-08-20
- Supersedes: [ADR 0004](./0004-complete-review-bypass.md) and the shortcut portion of [ADR 0003](./0003-destructive-preflight.md)

> Current note (2026-08-20): `detailed_review` remains the default and follows this complete transaction. ADR 0011 now permits a separately confirmed, default-off `settings_direct` path that skips the displayed review but retains a fresh read-only preflight, single-use binding, current-authority reconstruction, and truthful report mode. The text below records the detailed-review decision and the source state before ADR 0011.

## Context

SiteWipe can coordinate irreversible changes across cookies, site storage, tabs, history, download records, and—when separately enabled in Expert mode—downloaded files. The exact effects depend on normalized scope, associated targets, browser context, settings, browser support, discovered counts, temporary permission needs, and live browser state. A settings-time warning cannot communicate those per-run facts.

The prior private candidate allowed a complete detailed-review bypass in Standard and Expert modes. Although its token and target guards remained, it removed meaningful per-run consent and was a P0 publication blocker.

## Decision

Every cleanup uses this transaction:

1. The user enters or selects a target and activates **Review cleanup**.
2. A read-only preflight normalizes the primary and associated targets and inspects browser-exposed impact without invoking mutation-capable cleanup APIs.
3. SiteWipe displays the active Standard/Expert mode; entered target; normalized registrable site or exact local origin; subdomain and associated scope; normal/private context; selected, unsupported, and protected categories; known and unknown impacts; exact required target-access patterns; request-shield behavior; report retention; downloaded-file effects; limitations; and verification boundary.
4. The user completes every applicable acknowledgement. Expert downloaded-file deletion additionally requires typing the normalized target.
5. The user explicitly activates final approval from that review.
6. Only then may SiteWipe request missing displayed host patterns and submit the versioned `detailed_review` message.
7. The service worker consumes the short-lived, single-use, context-bound record before extension-state recovery, request-shield installation, or browser-data mutation.
8. Current effective settings and browser private-access state are re-read; target/associated scope and the complete normalized displayed impact/review snapshot are reconstructed; and permission partition, context, acknowledgements, and file IDs are exact-compared. A dedicated authorization module independently rejects any other approval mode and records distinct preflight and final-review timestamps.

The same contract applies in Standard and Expert modes. A browser permission prompt is a separate browser control and never substitutes for step 3 or step 5.

## Migration and fail-closed behavior

- The legacy setting is ignored and deleted during settings normalization/import.
- The preflight schema version is advanced whenever the authority snapshot changes. The current schema rejects both bypass-era records and later records that did not bind the complete displayed impact/review.
- Quick/bypass fields are not exported in review metadata or accepted by message schemas.
- A stale popup, forged message, changed setting, changed target/associated scope, changed browser private-access state, altered displayed impact/limitation/access pattern, expired token, duplicate token, wrong source window/private context, incomplete high-risk acknowledgement, or newly discovered file ID fails closed.
- Cancellation before final approval creates no cleanup job or DNR rule. Any temporary-access lease is reconciled without resuming data deletion.

## Consequences

Cleanup is intentionally a two-stage SiteWipe interaction: prepare/review, then approve. Chrome/Brave may add a native permission interaction when target access is missing. This is safer than a one-action design but does not make deletion recoverable or eliminate browser-state races. Installed Chrome and Brave evidence must still verify focus, stale-page, prompt, popup-close, worker-stop, restart, denial, and timeout behavior against the exact artifact.
