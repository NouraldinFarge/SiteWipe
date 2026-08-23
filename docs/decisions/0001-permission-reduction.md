# ADR 0001: Replace required all-sites access with reviewed target access

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Accepted for the public-source prerelease; permission-gesture details updated by ADRs 0011 and 0012; installed-browser validation pending
- Date: 2026-08-16

## Context

The baseline requested required `<all_urls>` plus 13 named permissions. That granted page/cookie authority across all sites at install time even though cleanup is target-scoped. `sessions` was used only for recently closed discovery despite Chrome offering no matching deletion API, and `contentSettings` remained from a legacy migration path.

## Decision

- Declare `http://*/*` and `https://*/*` only in `optional_host_permissions`.
- Keep scope preflight and the default detailed review read-only; preflight never requests target host access.
- In default `detailed_review`, the complete review produces the final approval. In explicitly enabled `settings_direct`, hidden preflight and the durable prompt-pending lease complete before **Clean now** is enabled. With exact access pregranted, either prepared mode submits its preflight-bound cleanup route in one SiteWipe activation. If normal-window access is missing, activation one durably arms the exact approval, awaits the matching nonce-bound `armed` acknowledgement, and opens one exact worker-created extension-owned handoff tab without requesting access or starting cleanup. A fresh activation in that bound tab requests only the missing normalized patterns. If access is withheld, no cleanup is admitted.
- Record pre-existing access per origin rather than as one aggregate Boolean. Before any permission prompt, persist a durable lease containing the exact requested/pre-existing/temporary partition and require the durable armed acknowledgement. Permission possession and events are never cleanup authority; admission still requires the exact unexpired arm and complete current reconstruction. Review expiry revokes cleanup authority but ordinary in-session expiry, alarm, startup, and maintenance retain an invoked prompt's non-runnable tombstone and lease. Complete exact grant proof arriving after expiry performs no cleanup and reconciles only target patterns that were absent before that review; a confirmed SiteWipe-owned lease is forgotten only after strict browser queries prove them absent. Without exact terminal handoff settlement, only a real browser-session boundary may retire unresolved invoked-prompt bookkeeping, and incompletely proved access is preserved.
- Permit only one unexpired review so another popup or handoff tab cannot overwrite the access-ownership record. The popup preparation capability and the separately minted handoff capability remain document-bound and in-memory only. A direct-open, duplicated, reloaded, navigated, replaced, or wrong-context handoff tab cannot inherit the permission step; incomplete settlement recovery-locks new cleanup until the armed record is admitted after complete proof or conservatively reconciled.
- Remove `sessions` and `contentSettings`.
- Keep `webNavigation` optional for Expert embedded-frame discovery.
- Retain the named permissions required for the default multi-API cleanup, with runtime target guards described in `docs/permissions.md`.

## Alternatives considered

1. Keep required `<all_urls>` for prompt-free operation: rejected because convenience did not justify default global page/cookie authority.
2. Use only `activeTab`: rejected because it cannot authorize matching cookies, other target tabs/frames, later verification, or multi-origin target work.
3. Make history/downloads optional immediately: deferred because they are displayed default cleanup categories and require a coherent capability-selection/permission UX, not a manifest-only change.
4. Keep `sessions` for discovery: rejected because observation without a safe targeted forget operation expanded authority without completing cleanup.

## Consequences

Pregranted exact access keeps final detailed or direct submission to one SiteWipe activation. Missing normal-window access requires the durable first-arm/exact-ack activation, a second fresh permission activation in the exact worker-created handoff tab, and Chrome/Brave's separate target-specific confirmation; the user may refuse it, in which case no cleanup is admitted. If the handoff document or worker stops after the browser grants access but before complete admission proof, the local durable lease and armed record preserve the recovery obligation across service-worker or browser restart, but permission possession or an event alone creates neither cleanup nor removal authority. A direct-open or replacement page cannot continue the document-bound permission step and remains recovery-locked. Review expiry invalidates admission but does not prove an invoked native prompt ended; ordinary in-session maintenance retains its tombstone and lease until exact terminal settlement or a real browser-session boundary. If complete proof arrives late, the worker runs no cleanup, reconciles only exact preflight-classified temporary access, and preserves a durable canceled result. Access can therefore remain temporarily until exact settlement, a successful proof-backed removal retry, a browser-session boundary, or manual revocation. A private-source run never requests missing access and requires exact target access before preflight. Grant/release, prompt-open-past-expiry, crash, restart, mixed pre-existing/missing access, withholding, and both authorization modes must still be validated in installed Chrome and Brave before a public claim. See [ADR 0011](./0011-optional-direct-cleanup.md), historical [ADR 0012](./0012-worker-owned-permission-handoff.md), and current [ADR 0013](./0013-persistent-permission-handoff-tab.md).
