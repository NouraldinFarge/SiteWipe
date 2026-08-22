# ADR 0001: Replace required all-sites access with reviewed target access

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Accepted for the public-source prerelease; permission-gesture details updated by ADR 0011; installed-browser validation pending
- Date: 2026-08-16

## Context

The baseline requested required `<all_urls>` plus 13 named permissions. That granted page/cookie authority across all sites at install time even though cleanup is target-scoped. `sessions` was used only for recently closed discovery despite Chrome offering no matching deletion API, and `contentSettings` remained from a legacy migration path.

## Decision

- Declare `http://*/*` and `https://*/*` only in `optional_host_permissions`.
- Keep scope preflight and the default detailed review read-only; preflight never requests target host access.
- In default `detailed_review`, request only missing normalized target patterns from the explicit final review approval. In explicitly enabled `settings_direct`, hidden preflight and the durable prompt-pending lease complete before **Clean now** is enabled; that one SiteWipe action may then request only its missing normalized target patterns before submitting the same preflight-bound cleanup route. If access is withheld, no cleanup message is sent. Chrome/Brave may display its own browser-controlled prompt, which is separate from the saved direct authorization.
- Record pre-existing access per origin rather than as one aggregate Boolean. Before any permission prompt, persist a durable lease containing the exact requested/pre-existing/temporary partition. Completion, failure, cancellation, review expiry, restart maintenance, and extension-local reset reconcile only target patterns that were absent before that review, and forget the lease only after strict browser queries prove them absent.
- Permit only one unexpired review so a second popup cannot overwrite the access-ownership record for the first.
- Remove `sessions` and `contentSettings`.
- Keep `webNavigation` optional for Expert embedded-frame discovery.
- Retain the named permissions required for the default multi-API cleanup, with runtime target guards described in `docs/permissions.md`.

## Alternatives considered

1. Keep required `<all_urls>` for prompt-free operation: rejected because convenience did not justify default global page/cookie authority.
2. Use only `activeTab`: rejected because it cannot authorize matching cookies, other target tabs/frames, later verification, or multi-origin target work.
3. Make history/downloads optional immediately: deferred because they are displayed default cleanup categories and require a coherent capability-selection/permission UX, not a manifest-only change.
4. Keep `sessions` for discovery: rejected because observation without a safe targeted forget operation expanded authority without completing cleanup.

## Consequences

Users may see a target-specific browser permission prompt after the detailed final approval or after the one SiteWipe action in direct mode, and may refuse it. Cleanup then stops before its destructive request is accepted. If the popup or worker stops after the browser grants access but before the run starts, the local durable lease—not the session token alone—retains exact per-origin ownership across service-worker or browser restart. A live unexpired prepared lease is not mistaken for an orphan; after expiry or interruption, maintenance releases only temporary patterns and retains recovery state whenever removal or absence cannot be proved. Access can therefore remain temporarily until a successful wake/retry or manual revocation. A private-source direct run never requests missing access and requires exact target access before preflight. Grant/release, crash, restart, mixed pre-existing/missing access, withholding, and both authorization modes must still be validated in installed Chrome and Brave before a public claim. See [ADR 0011](./0011-optional-direct-cleanup.md).
