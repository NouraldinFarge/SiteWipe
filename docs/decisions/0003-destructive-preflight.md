# ADR 0003: Require a deterministic destructive preflight and approval

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

- Status: Accepted; shortcut policies superseded by ADR 0009
- Date: 2026-08-16

## Context

The baseline could start tab closing and data removal after one primary action. Normalization, associated expansion, private scope, file deletion, request shielding, verification, and report persistence were not presented together as an authorization boundary.

## Decision

Split cleanup into a read-only preflight transaction and a destructive execution transaction. The preflight computes entered and normalized targets, match mode, subdomain/associated/private scope, attempted/protected/unsupported categories, tab/history/download/file effects, DNR/verification behavior, and report retention. It stores one random session-only approval for five minutes and refuses to overwrite a still-live transaction.

Detailed scope review is mandatory in Standard and Expert modes. Associated targets, exact local/IP origins, protected/PWA data, private-window scope, on-disk file removal, and missing target access receive explicit per-run presentation and acknowledgement. File deletion requires typing the normalized target and remains bound to preflight-captured completed IDs.

The original conditional shortcut and later complete-bypass experiment are superseded by [ADR 0009](./0009-mandatory-cleanup-review.md). Legacy settings and preflight records are discarded. The message contract, approval consumer, and reviewed-cleanup authorization boundary accept only `detailed_review`.

For a detailed approval, the popup first requests only missing reviewed host patterns. Execution then consumes the token before mutation, binds it to the source window/private context and preflight settings/target/impact, and requires separate acknowledgements for associated targets, exact local origins, protected/PWA data, and on-disk files.

Mutation adapters do not rely on the preview snapshot alone. Every explicit origin/type plan is independently checked against the approved primary and associated targets immediately before browser-data removal. Each candidate tab is re-read and re-matched immediately before it is changed or closed; a closed, unavailable, or navigated-away tab is skipped.

## Alternatives considered

- A generic confirmation dialog: rejected because it does not communicate normalized scope or changed high-risk options.
- Any complete or conditional review bypass: rejected because a settings-time choice cannot communicate the exact scope, impacts, permissions, limitations, and irreversible effects of the current run.
- Starting recovery/DNR before approval: rejected because those are mutation-capable extension/browser operations.

## Consequences

Both modes always use the detailed approval step. ADR 0004 is retained only as a historical, superseded record. Canceling or expiring preflight removes the validated session record and creates no job/rule; extension-local reset also clears pending authority. Any temporary target access is tracked by a separate durable lease and is forgotten only after browser absence is proved. Approval cannot make deletion recoverable. Browser state can still change between the final revalidation and Chrome's own asynchronous mutation, so installed tests and UI wording must preserve that residual race.
