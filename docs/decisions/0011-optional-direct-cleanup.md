# ADR 0011: Allow an opt-in preflight-bound direct cleanup

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Accepted for the public-source prerelease; installed-browser validation pending
- Date: 2026-08-20
- Owner decision: [`direct-cleanup-owner-decision.json`](./direct-cleanup-owner-decision.json)
- Supersedes: the mandatory-display requirement in [ADR 0009](./0009-mandatory-cleanup-review.md)
- Preserves: the deterministic preflight and mutation boundary in [ADR 0003](./0003-destructive-preflight.md)

## Context

The owner explicitly requested an off-by-default setting that skips SiteWipe's detailed per-run cleanup screen, works in Standard and Expert modes, and makes the popup workflow one SiteWipe cleanup action. The requested experience must also operate from a private window when the browser has granted **Allow in incognito**.

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

One activation of the now-enabled **Clean now** button then:

1. invokes `permissions.request()` first for only the missing preflight-derived exact target patterns and retains its promise, then immediately dispatches the worker-owned arm without awaiting it before the first `await`; the permission promise is the first awaited, gesture-gated browser call from that activation, the arm carries the preparation-bound popup capability described by [ADR 0012](./0012-worker-owned-permission-handoff.md), and Chrome or Brave may require an additional native confirmation;
2. submits the ordinary `runDeepClean` route with the prepared token and an explicit `settings_direct` approval that truthfully claims no per-run review acknowledgements or typed file phrase; and
3. consumes the token and reconstructs the current settings, scope, private-access state, permission inventory, impact, permission lease, and file-ID evidence before recovery, job creation, request shielding, or browser-data mutation.

There is no raw direct-cleanup message, caller-controlled skip Boolean, unbound file-ID list, synthetic `reviewedScope: true`, or cleanup route that can avoid consuming the prepared record. A mismatch, stale/expired/replayed token, settings change, source-window/private change, access change, impact tamper, or file-ID change fails closed before cleanup mutation.

Expert downloaded-file deletion remains off by default and restricted to completed IDs captured by that fresh preflight. Direct mode intentionally skips the typed per-run phrase because the persisted, explicitly confirmed setting is the authorization choice; immediate exact-record target/state/identity revalidation and preserve-on-uncertainty behavior remain mandatory.

## Incognito and permission behavior

The extension cannot enable private-window access. **Allow in incognito** remains a browser-controlled prerequisite. A direct cleanup started from a private source window additionally requires all exact target host patterns to exist before preflight. Under the current lease policy, SiteWipe does not open a native host-permission prompt from the private direct path and does not persist a missing/temporary private target pattern. Normal-window direct cleanup may encounter one native Chrome/Brave site-access confirmation after **Clean now**; that browser UI is a separate platform interaction, so “one click” means one SiteWipe popup cleanup action, not a guarantee that the browser will never ask for permission.

The session approval expires after five minutes. The normal-window `prompt_pending` lease uses a separate conservative 30-minute recovery window so a native prompt opened near approval expiry cannot grant access after SiteWipe has discarded its ownership record. Explicit denial/abandonment can force earlier exact-origin reconciliation; otherwise maintenance retains the obligation until the prompt deadline and strict permission checks prove temporary patterns absent. This is a recovery bound, not a promise about how long the browser prompt stays open.

## Reporting and migration

Reports identify the actual mode as `summary.cleanupApprovalMode: "settings_direct"`, set `scopeReviewApproved` to `false`, set `settingsDirectCleanupAuthorized` to `true`, record `directCleanupAuthorizedAt`, and separately report the preflight-bound downloaded-file candidate count. They must not say that the detailed scope was reviewed or that a per-run file phrase was entered.

Existing installations and imports normalize to detailed review unless `skipCleanupReview` is explicitly present as strict Boolean `true`. Enabling it through the Settings UI requires the explicit warning confirmation. Settings import must classify enabling it as a destructive authorization risk and include it in the import confirmation; a legacy quick/bypass mode or approval record is not accepted.

## Consequences and required evidence

This design gives the owner-requested fast path while retaining target, settings, context, permission, impact, file-identity, single-use, and adapter safety boundaries. It deliberately trades away per-run visibility and acknowledgements when the opt-in is enabled. A saved setting cannot make deletion recoverable, eliminate live browser races, or substitute for installed evidence.

Before a supported binary or store submission, exact-artifact disposable-profile tests must cover default-off behavior, the Settings confirmation, Standard and Expert direct runs, associated/protected/file effects, native prompt grant/denial/abandonment, stale settings and private-state changes, popup close/service-worker restart, report truthfulness, token replay, and enabled/disabled incognito paths. Installed Chrome/Brave, native prompt, file-system, accessibility, and performance evidence remains pending and must not be fabricated from source or synthetic Browser tests.
