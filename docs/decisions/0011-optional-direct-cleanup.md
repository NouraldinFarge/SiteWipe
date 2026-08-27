# ADR 0011: Allow an opt-in preflight-bound direct cleanup

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Accepted for the public-source prerelease; exact installed-browser status belongs only to active browser evidence
- Date: 2026-08-20
- Owner decision: [`direct-cleanup-owner-decision.json`](./direct-cleanup-owner-decision.json)
- Supersedes: the mandatory-display requirement in [ADR 0009](./0009-mandatory-cleanup-review.md)
- Preserves: the deterministic preflight and mutation boundary in [ADR 0003](./0003-destructive-preflight.md)

## Context

The owner explicitly requested an off-by-default setting that skips SiteWipe's detailed per-run cleanup screen, works in Standard and Expert modes, and minimizes the popup workflow. The requested experience must also operate from a private window when the browser has granted **Allow in incognito**. The accepted safety contract keeps a one-activation final path when exact access is already granted, but deliberately requires two SiteWipe activations when a normal-source run is missing exact access.

The historical implementation described by [ADR 0004](./0004-complete-review-bypass.md) was removed because it did not have the current complete preflight binding, current-settings/private-context reconstruction, permission-inventory controls, downloaded-file identity controls, truthful report mode, or an owner-approved publication contract. This decision does not retroactively approve that implementation or alter its false historical approval record.

## Decision

SiteWipe supports two preflight-bound authorization modes:

- `detailed_review` is the default. It displays the complete fresh scope-and-impact review and requires every applicable acknowledgement. Expert downloaded-file deletion also requires the typed per-run target phrase.
- `settings_direct` is available only when the user explicitly enables **Skip detailed cleanup review completely** (`skipCleanupReview`) in Settings and confirms a warning describing Standard, Expert, irreversible file, associated/protected, private-window, and native-permission-prompt consequences. The setting defaults to `false` and is available in both cleanup modes.

With `settings_direct`, entering or selecting a valid target starts hidden preparation. Before **Clean now** is enabled, SiteWipe:

1. performs the same fresh, read-only impact and host-access preflight used by detailed review;
2. derives `settings_direct` from the current normalized stored setting—not from a caller-provided skip flag;
3. stores a short-lived, single-use approval bound to the normalized target, effective settings, associated targets, source window/private state, browser incognito-access state, relevant host-permission inventory, complete impact snapshot, exact downloaded-file candidate IDs, and permission lease; and
4. places that durable lease in `prompt_pending` so any later native grant has a recovery obligation before the button becomes actionable.

When every exact target pattern was pregranted, one activation of the now-enabled **Clean now** button:

1. submits the ordinary `runDeepClean` route with the prepared token and an explicit `settings_direct` approval that truthfully claims no per-run review acknowledgements or typed file phrase; and
2. consumes the token and reconstructs the current settings, scope, private-access state, permission inventory, impact, permission lease, and file-ID evidence before recovery, job creation, request shielding, or browser-data mutation.

When a normal-source direct run is missing exact access, the final workflow instead has two SiteWipe activations:

1. the first **Clean now** activation sends `armCleanupApproval` with the preparation-bound popup capability described by historical [ADR 0012](./0012-worker-owned-permission-handoff.md), awaits the worker response, and proceeds only after receiving the exact matching nonce and durable `armed` acknowledgement; it does not invoke `permissions.request()` or start cleanup;
2. the worker creates or focuses one extension-owned handoff tab described by [ADR 0013](./0013-persistent-permission-handoff-tab.md), binds a separately minted in-memory capability to its exact tab and worker-resolved `TAB` context, and exposes **Grant reviewed access and run** only in that document;
3. a fresh activation in the exact bound handoff document synchronously invokes `permissions.request()` for only the missing preflight-derived exact target patterns and Chrome or Brave may require its separate native confirmation; and
4. handoff settlement or a permission event may wake the worker, which admits the ordinary single-use route only after the exact unexpired arm, authenticated invocation, literal-true/valid-pre-request-absence outcome, exact complete host-only event, reviewed permission ownership, complete current authority, and current exact grant reconstruct successfully. Permission possession and permission events are never authority.

The popup preparation capability and the separately minted handoff capability remain document-bound and in-memory only. The static handoff URL contains no token, nonce, capability, target, or host pattern. Directly opening, copying, duplicating, reloading, navigating, replacing, or reopening the page cannot continue or re-arm the approval. Losing the exact handoff document before authenticated outcome proof starts no cleanup and preserves ambiguously granted access while the existing record is conservatively reconciled.

There is no raw direct-cleanup message, caller-controlled skip Boolean, unbound file-ID list, synthetic `reviewedScope: true`, or cleanup route that can avoid consuming the prepared record. A mismatch, stale/expired/replayed token, settings change, source-window/private change, access change, impact tamper, or file-ID change fails closed before cleanup mutation.

Expert downloaded-file deletion remains off by default and restricted to completed IDs captured by that fresh preflight. Direct mode intentionally skips the typed per-run phrase because the persisted, explicitly confirmed setting is the authorization choice; immediate exact-record target/state/identity revalidation and preserve-on-uncertainty behavior remain mandatory.

## Incognito and permission behavior

The extension cannot enable private-window access. **Allow in incognito** remains a browser-controlled prerequisite. A direct cleanup started from a private source window additionally requires all exact target host patterns to exist before preflight. Under the current lease policy, SiteWipe does not open a native host-permission prompt from the private direct path and does not persist a missing/temporary private target pattern. Normal-window direct cleanup stays one SiteWipe activation when access is pregranted; when access is missing it uses the durable popup arm followed by the exact worker-created handoff-tab activation above plus Chrome/Brave's separate native confirmation.

The session approval expires after five minutes. The normal-window `prompt_pending` lease uses a separate conservative 30-minute recovery window so a native prompt opened near approval expiry cannot grant access after SiteWipe has discarded its ownership record. Explicit denial/abandonment can force earlier exact-origin reconciliation; otherwise maintenance retains the obligation until the prompt deadline and strict permission checks prove temporary patterns absent. This is a recovery bound, not a promise about how long the browser prompt stays open.

## Reporting and migration

Reports identify the actual mode as `summary.cleanupApprovalMode: "settings_direct"`, set `scopeReviewApproved` to `false`, set `settingsDirectCleanupAuthorized` to `true`, record `directCleanupAuthorizedAt`, and separately report the preflight-bound downloaded-file candidate count. They must not say that the detailed scope was reviewed or that a per-run file phrase was entered.

Existing installations and imports normalize to detailed review unless `skipCleanupReview` is explicitly present as strict Boolean `true`. Enabling it through the Settings UI requires the explicit warning confirmation. Settings import must classify enabling it as a destructive authorization risk and include it in the import confirmation; a legacy quick/bypass mode or approval record is not accepted.

## Consequences and required evidence

This design gives the owner-requested fast path while retaining target, settings, context, permission, impact, file-identity, single-use, and adapter safety boundaries. It deliberately trades away per-run visibility and acknowledgements when the opt-in is enabled. A saved setting cannot make deletion recoverable, eliminate live browser races, or substitute for installed evidence.

Before a supported binary or store submission, exact-artifact disposable-profile tests must cover default-off behavior, the Settings confirmation, Standard and Expert direct runs, pregranted one-activation admission, missing-access first-arm/exact-ack/handoff-tab request ordering, associated/protected/file effects, native prompt grant/denial/abandonment, stale settings and private-state changes, exact tab/context binding, absent optional sender document ID, direct-open/duplicate/reload/navigation/replacement rejection, handoff-page close and restart recovery, raw-capability non-persistence, permission-event/no-possession authority, report truthfulness, token replay, and enabled/disabled incognito paths. Exact installed Chrome/Brave, native-prompt, file-system, accessibility, and performance status belongs only to its active evidence; source or synthetic Browser tests cannot create those results.
