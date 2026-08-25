# ADR 0013: Move missing-access activation into a persistent extension-owned handoff tab

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Accepted in the 1.11.67 corrective successor and retained for 1.11.78; active evidence governs local validation and exact-artifact installed validation remains pending
- Date: 2026-08-22
- Supersedes: only ADR 0012's same-action-popup activation-two mechanism
- Preserves: ADR 0012's durable arm, independent grant proofs, exactly-once admission, permission-ownership provenance, and fail-closed settlement boundaries

## Context

Exact installed SiteWipe 1.11.57 in a disposable Brave Nightly `151.1.95.33` profile durably armed the reviewed Standard approval and requested only the four disclosed `example.com` patterns. Brave granted those patterns but destroyed the action-popup document before its awaited `permissions.request()` continuation could report the required literal-true result and valid pre-request-absence proof. The worker separately observed the exact complete host-only grant event but correctly kept the permission lease proofless and admitted no cleanup. No job, report, matching-tab closure, fixture mutation, downloaded-file action, or automatic permission removal occurred.

The failure shows that an action-popup document cannot be the required post-prompt outcome witness on browsers that destroy it during native permission UI. Removing the independent outcome proof would be unsafe: permission possession or an event alone cannot prove that this reviewed SiteWipe interaction created the grant, so it also cannot safely authorize cleanup or later automatic removal.

The owner's recorded interaction approval remains one SiteWipe activation when exact access is pregranted and two explicit SiteWipe activations when normal-window access is missing. This decision changes only the extension surface that owns activation two. The owner's 2026-08-24 instructions authorize preparing and pushing the exact 1.11.78 source candidate, opening its pull request, and taking later GitHub/publication actions only after their applicable gates genuinely pass. They do not manufacture installed evidence, waive protection or independent review, or establish any supported-binary claim.

## Decision

When exact normal-window target access is missing:

1. The action popup performs the ordinary detailed or saved-direct preflight, holds its existing worker-minted preparation capability only in memory, and sends `armCleanupApproval` from the exact worker-verified popup context.
2. The worker validates the complete preflight-bound authority and durably acknowledges `armed`. Activation one requests no browser permission and starts no cleanup.
3. The worker creates or focuses exactly one extension-owned `handoff/handoff.html` tab for that nonce in the reviewed normal source window without resizing it. It records the newly created `about:blank` tab ID before navigating that tab to the packaged handoff document.
4. The handoff document claims the record only from that exact worker-created tab and reviewed window, top frame, normal extension context, extension origin, and packaged URL. The worker resolves exactly one matching `runtime.getContexts()` `TAB` context filtered by tab ID, document URL, frame ID `0`, and `incognito: false`, then binds its opaque required `contextId`. Optional sender/context `documentId` may be cross-checked when present but is never required and never substitutes for `contextId`.
5. The worker mints a new 256-bit, single-use handoff capability for that exact document, persists only its SHA-256 digest with the tab/context/nonce binding, and returns the raw capability only to that handoff document's memory.
6. A fresh explicit control in that exact handoff document performs activation two. It dispatches authenticated non-runnable begin intent, synchronously starts `permissions.getAll()` immediately before `permissions.request()` for only the preflight-derived missing patterns, and immediately authenticates accepted invocation before awaiting the native result.
7. Only a literal `true` result paired with a valid pre-request inventory proving every reviewed temporary origin absent from exact and broader coverage may record the handoff-document-authenticated outcome with `preRequestTemporaryOriginsAbsent: true`.
8. Independently, only one exact complete host-only `permissions.onAdded` event equal to the complete reviewed temporary set may record `promptGrant.complete`.
9. Cleanup admission and prompt-owned permission removal still require the unexpired arm, authenticated invocation, both independent grant proofs, pre-request absence, exact current grant, complete authority reconstruction, matching schema-3 reviewed/admitted permission-lease provenance, and the exactly-once admission boundary. The approval handoff itself advances to schema 3 so an old schema-2 armed popup record cannot be rebound into this flow.

Pregranted exact access continues through the existing one-activation popup route. A private-source run remains ineligible for this missing-access handoff: browser-controlled **Allow in incognito** and exact target access must already exist before preflight.

## Binding and persistence rules

- The static handoff URL contains no nonce, token, capability, target, host pattern, or other authority-bearing value in its path, query, fragment, title, or history entry.
- The raw handoff capability may not enter extension storage, the cleanup review, permission lease, active job, report, export, maintenance snapshot, diagnostics, console output, or debug log. Only its digest may persist.
- A directly opened, copied, duplicated, navigated, reloaded, replaced, wrong-window, private, wrong-frame, wrong-tab, wrong-context, or expired handoff document cannot claim or continue the approval.
- At most one handoff tab may own one unexpired nonce. Focusing an already bound tab does not mint a second capability or create a second cleanup authority.
- Page presence, host-permission possession, permission events, tab identity, and capability possession are each insufficient alone. Every message is revalidated against the durable nonce, exact tab/context, capability digest, current review, lease, expiry, and appropriate one-time state.
- Reloading or replacing the document invalidates its in-memory raw capability. Authority is not reconstructed merely because the tab ID or packaged URL still matches.

## Failure, closure, and recovery

Closing, navigating, reloading, replacing, or losing the handoff document before admission starts no cleanup. Incomplete proof never authorizes automatic removal; access is preserved when ownership is ambiguous, and SiteWipe retains or reconciles only its bounded recovery bookkeeping. Once exactly-once admission is durable, later handoff-page loss clears only its UI binding while the worker-owned job and permission reconciliation continue. Denial, dismissal, synchronous request failure, invalid or already-covering pre-request inventory, expiry, settings/target/source/private changes, permission removal, worker restart, malformed state, and duplicate messages remain non-runnable.

Review expiry revokes cleanup authority but does not prove that an already invoked native browser prompt has settled. Ordinary in-session maintenance must retain the non-runnable prompt tombstone and matching `prompt_pending` lease while that prompt can still resolve. If the browser grants after expiry, SiteWipe still requires the exact complete host-only event and the bound handoff document's literal-true/pre-request-absence outcome before removing only the preflight-classified temporary patterns; it never admits the expired cleanup. The terminal canceled/reconciled result remains durably bound to the used handoff nonce so concurrent wake-only maintenance, response loss, or service-worker restart cannot turn a proven release into an indefinite outcome. Unobserved prompt bookkeeping may be discarded only after explicit denial/dismissal or a real browser-session boundary where the former native prompt cannot later grant access.

A literal-true outcome without the exact event remains non-runnable through the bounded review/tombstone window so a delayed exact event may complete once. Event-only state cannot synthesize the outcome, and outcome-only state cannot synthesize the event. Admission may create exactly one nonce-bound job. After admission, ordinary durable job/report state—not the handoff page—governs progress and terminal recovery.

The handoff does not change downloaded-file policy. Standard mode never deletes downloaded files. Expert on-disk deletion remains off by default and requires its existing saved setting, preflight-bound completed file IDs, and immediate live identity/state/target revalidation; uncertainty preserves both the file and browser record.

Terminalization is monotonic: exact reconciliation is proved first; the matching used handoff then stores and rereads one canceled result; only after that durable write may the owned review and lease retire. A write rejected before commit retains those recovery records, while a commit-then-reject may continue only after rereading the identical stored result. This ordering lets startup maintenance finish the same expired handoff without creating cleanup or an indefinite outcome.

## Required evidence

Source and adversarial checks must cover absent optional sender document ID; exact worker-created about:blank-to-packaged-URL tab in the reviewed normal source window without resizing; exact sender tab/window/URL/frame/origin and unique normal `TAB` context acceptance; zero/multiple/mismatched context rejection; old schema-2 record rejection; direct-open, duplicate, reload, navigation, replacement, replay, stale, and wrong-capability rejection; no raw-capability URL or persistence sink; fresh user activation at `permissions.request()`; exact event/outcome ordering; page destruction before and after each proof and after admission; denial/dismissal; worker suspension/restart; an unresolved invoked prompt across review expiry and full ordinary maintenance; maintenance between late event/outcome proofs; durable terminal canceled replay; expiry and authority invalidation; one-job admission; exact temporary-access release; private-source refusal; and downloaded-file preservation.

Those source checks do not establish installed behavior. The exact 1.11.57, 1.11.61, and 1.11.62 failures remain historical evidence. A forward 1.11.78 artifact must be loaded into fresh disposable Chrome and Brave profiles and retain exact-artifact evidence before any compatibility, merge, binary, or store claim. Installed accessibility, performance, media, hosted-policy parity, independent review, and stage-specific publication safeguards remain separate later-stage gates. Exact-head CI and CodeQL are established on the pushed source-candidate pull-request head and do not imply that another gate passed.
