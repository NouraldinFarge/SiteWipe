# ADR 0003: Require a deterministic destructive preflight and approval

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Accepted; presentation/authorization modes updated by ADR 0011
- Date: 2026-08-16

## Context

The baseline could start tab closing and data removal after one primary action. Normalization, associated expansion, private scope, file deletion, request shielding, verification, and report persistence were not presented together as an authorization boundary.

## Decision

Split cleanup into a read-only preflight transaction and a destructive execution transaction. The preflight computes entered and normalized targets, match mode, subdomain/associated/private scope, attempted/protected/unsupported categories, tab/history/download/file effects, DNR/verification behavior, and report retention. It stores one random session-only approval for five minutes and refuses to overwrite a still-live transaction.

Detailed scope review remains the default in Standard and Expert modes. In that mode, associated targets, exact local/IP origins, protected/PWA data, private-window scope, on-disk file removal, and missing target access receive explicit per-run presentation and acknowledgement, and file deletion requires typing the normalized target. ADR 0011 adds an explicitly confirmed `settings_direct` mode that skips those per-run acknowledgements while retaining the same fresh preflight and preflight-captured completed file IDs.

The original conditional shortcut and later complete-bypass experiment remain retired under [ADR 0009](./0009-mandatory-cleanup-review.md). Legacy quick/bypass messages and preflight records are discarded. The current message contract, approval consumer, and authorization boundary accept only `detailed_review` or the setting-derived, preflight-bound `settings_direct` mode defined by [ADR 0011](./0011-optional-direct-cleanup.md).

For a detailed approval, the popup first requests only missing reviewed host patterns. For a normal-source direct approval, **Clean now** may request only missing preflight-derived host patterns. A private-source direct approval requires exact target access before preflight. Execution in either mode consumes the token before mutation and binds it to the source window/private context and preflight settings/target/impact. Detailed mode requires the applicable acknowledgements; direct mode truthfully submits false acknowledgement fields and an empty file phrase.

Mutation adapters do not rely on the preview snapshot alone. Every explicit origin/type plan is independently checked against the approved primary and associated targets immediately before browser-data removal. Each candidate tab is re-read and re-matched immediately before it is changed or closed; a closed, unavailable, or navigated-away tab is skipped.

## Alternatives considered

- A generic confirmation dialog: rejected because it does not communicate normalized scope or changed high-risk options.
- An unbound quick/bypass route: rejected because it could omit the fresh target/settings/context/impact/file-ID authority snapshot. ADR 0011 accepts only a saved, explicitly confirmed direct authorization backed by that complete hidden preflight and truthful reporting.
- Starting recovery/DNR before approval: rejected because those are mutation-capable extension/browser operations.

## Consequences

Both cleanup modes default to detailed approval; the saved `skipCleanupReview` opt-in selects direct authorization in either mode. ADR 0004 is retained only as a historical, superseded record. Canceling, abandoning, or expiring preflight removes the validated session record and creates no cleanup job/rule; extension-local reset also clears pending authority. Any temporary normal-window target access is tracked by a separate durable lease and is forgotten only after browser absence is proved. Authorization cannot make deletion recoverable. Browser state can still change between final revalidation and Chrome's own asynchronous mutation, so installed tests and UI wording must preserve that residual race.
