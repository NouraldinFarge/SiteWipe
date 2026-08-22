# ADR 0012: Make optional-host-permission handoff worker-owned and popup-context-bound

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Implemented and independently source-audited with no concrete P0/P1 finding; exact-artifact installed validation of the current corrective candidate pending
- Date: 2026-08-21
- Amends: the native-permission continuation in [ADR 0011](./0011-optional-direct-cleanup.md)
- Preserves: the deterministic preflight and mutation boundary in [ADR 0003](./0003-destructive-preflight.md)

## Context and installed failure

The exact installed SiteWipe 1.11.38 Standard test used `sitewipe-unreleased-candidate-1.11.38.zip` with SHA-256 `4CE25902BA754F05E33362308B58873BB6F8F437E0BD2ABA4A76F9504D2EC87E` and reached Chrome's native optional-host-permission prompt for the four reviewed patterns:

- `http://example.com/*`
- `https://example.com/*`
- `http://*.example.com/*`
- `https://*.example.com/*`

Chrome accepted that exact request, but opening the native prompt destroyed the action-popup document. The 1.11.38 popup awaited `permissions.request()` and planned to send `runDeepClean` only after the promise settled. Because the popup no longer existed, that continuation never ran. No cleanup job, report, request shield, or fixture mutation occurred, all three fixture snapshots remained unchanged, and the temporary grant was later removed. Incognito and downloaded-file deletion remained off, and no downloaded file was deleted. The fail-closed mutation boundary worked, but the user-approved cleanup did not start.

The installed run also exposed a separate freshness defect. A later popup instance restored the same review after its five-minute expiry and left final approval actionable. The worker correctly rejected the expired token, again without a job, report, shield, or fixture mutation. Worker-side rejection is necessary but does not make stale UI acceptable.

The worker-owned handoff implemented for SiteWipe 1.11.39 closed those source-level continuation and freshness paths, but its exact installed Standard run exposed a second release blocker before the detailed review. Chrome `151.0.7922.172` loaded `sitewipe-unreleased-candidate-1.11.39.zip` with SHA-256 `BAF78DEF05AC5E6960CD5FD98C0FF0CBDDA71688C6F0259C0A0C2A9E5D56A337`. From the seeded `example.com` fixture, **Review cleanup** failed with “The popup document preparing Chrome target access could not be verified. Reopen SiteWipe.” It reached no detailed review, native permission prompt, handoff, temporary-access lease, cleanup job, report, request shield, DNR mutation, or browser-data mutation. Fixture storage was not resnapshotted after the failed attempts, so this record makes no full post-run equivalence claim; incognito and downloaded-file deletion stayed off, and an independent rehash proved the protected downloaded file unchanged.

The 1.11.39 source required `runtime.MessageSender.documentId` during preparation and the Chrome mock supplied that field to every popup message. Chrome's runtime contract makes `MessageSender.documentId` optional, and the installed action-popup sender omitted it. By contrast, `ExtensionContext.contextId` returned by `runtime.getContexts()` is the required context identifier. Treating the optional sender field as mandatory therefore rejected a legitimate popup; merely accepting null or trusting the shared popup URL would remove the intended anti-replay boundary.

Both failures are release blocking. The first affects final continuation whenever browser UI destroys the popup. The second prevents legitimate popup preparation before either authorization mode can run. Reopening the popup and clicking a second SiteWipe control is not an acceptable direct-mode workaround: the product contract is one SiteWipe **Clean now** action plus any unavoidable browser-controlled confirmation.

## Decision

SiteWipe transfers the already prepared final approval to a worker-owned optional-permission handoff during the final popup activation. When no exact access is missing, the existing pregranted admission route remains available. Popup identity is established during preparation rather than reconstructed after native browser UI may have begun destroying the popup.

For `prepareCleanupReview`, the worker must:

1. require the exact extension popup URL, reject any sender with `sender.tab`, and independently verify the explicit source window ID and private state;
2. perform a bounded `runtime.getContexts()` query and require exactly one exact-URL `contextType: "POPUP"` context with the required opaque `contextId` and browser-correct action-popup metadata; Chrome action popups currently report `tabId: -1` and `windowId: -1`, so the positive source window and its private state remain a separate `chrome.windows.get` proof;
3. bind that context's required `contextId` to the short-lived review while treating `MessageSender.documentId` as optional rather than substituting an empty or caller-provided identity;
4. mint a high-entropy, single-review popup capability, persist only its SHA-256 digest with the review, and return the raw capability only in the response to that popup; and
5. keep the raw capability only in popup memory—never in the persisted review snapshot, session response cache, local storage, report, or debug evidence.

A response retry from the same bound popup context may rotate its capability only before a handoff or pending arm owns settlement. A pregranted review may rebind to a different popup only after `runtime.getContexts({ contextIds: [oldContextId] })` proves the old context no longer exists; the worker then resolves exactly one new matching popup and atomically updates its context binding plus capability digest. A missing-access review must not transfer to another popup merely because the old context disappeared: that popup may already have invoked Chrome's native prompt, so the worker converts the record into a permanently non-runnable reconciliation obligation until a real browser-session boundary permits a fresh review. A live old context, zero or multiple candidates, a type/URL/context/sentinel mismatch, an unavailable or failed context query, or a malformed record fails closed. SiteWipe's `spanning` popup context uses the shared extension profile even when the independently verified source window is private. A caller-supplied context ID alone is not authority because it can be copied or replayed.

When a normal-window preflight identified missing exact patterns, the final click performs this strict ordering before its first `await`:

1. synchronously invoke `permissions.request()` for only the preflight-bound missing exact patterns and retain the returned promise;
2. immediately dispatch `armCleanupApproval` with the raw popup capability and retain that message promise without awaiting it; and
3. make the permission promise the first **awaited, gesture-gated browser call** from the activation.

The permission API is invoked first to preserve Chrome's user-activation contract. The arm is dispatched immediately afterward in the same synchronous task and before the first await, so the prepared approval reaches the worker without requiring a post-prompt popup continuation. The worker deliberately does not call `runtime.getContexts()` during arm validation: the permission invocation may already be tearing down the popup, and a live-context requirement there would recreate the installed race.

Before the button was enabled, preflight already created a `prompt_pending` permission lease, a worker-generated random handoff nonce, and the context/capability binding. The popup cannot invent any of them. The worker accepts `armCleanupApproval` only from the exact popup URL with no `sender.tab` and after a constant-time comparison of the supplied raw capability with the stored digest. That proof binds the nonce, single-use review token, final detailed/direct approval, normalized target and associated targets, effective settings and mode, source window and private state, browser incognito-access state, complete impact and access inventory, exact file IDs, expiry, and lease. Missing, incorrect, replayed, or superseded capabilities fail closed. The capability is also required for explicit denied/abandoned settlement and any cancellation asserting `promptNotStarted: true`; another popup cannot settle or cancel the prepared prompt using only its token, nonce, URL, or copied context ID. An extension page other than the action popup, a content script, a web page, or a mismatched/replaced popup context cannot arm or explicitly settle it.

## State and exactly-once admission

The handoff has four explicit authority states:

| State              | May start cleanup? | Meaning                                                                                                                                                                                   |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arming`           | No                 | The worker owns settlement/recovery responsibility while it validates and persists the handoff. An early permission event cannot turn this state into cleanup authority.                  |
| `armed`            | Yes, after proof   | The only resumable state. It represents the exact final approval and context, but still requires fresh complete exact-grant and authority reconstruction before admission.                |
| `admitting`        | No retry           | The single winner crossed a permanent admission boundary. Duplicate popup continuations, permission events, worker wakes, or timeouts cannot retry this nonce as another cleanup.         |
| `prompt_tombstone` | No                 | The approval was invalidated while native browser UI might still settle. It retains only the bounded information needed to recognize and conservatively reconcile that prompt settlement. |

The popup may send `resumeArmedCleanup` if it survives the prompt. `chrome.permissions.onAdded` may also wake the service worker, including when the popup was destroyed. Both are wake signals only; neither is authority and neither is assumed to prove prompt provenance.

Every wake converges through the same serialized lifecycle reservation and fresh checks. Admission requires all of the following:

- an unexpired `armed` handoff with the exact worker nonce, approval token, source context, settings, target, impact, file evidence, and matching `prompt_pending` lease;
- a fresh `permissions.getAll()` inventory that contains every exact pattern classified temporary by that preflight;
- no substitution for that pending missing-access approval by a partial grant, a broader/all-sites grant, or a manually added permission when no matching handoff exists (a later fresh preflight may classify independently granted access as pre-existing); and
- successful reconstruction and single-use consumption of the ordinary cleanup authorization before any cleanup mutation.

The convergence handles either ordering: if `permissions.onAdded` arrives before `armed` is persisted, the arm path performs the same fresh proof after persistence; if `armed` exists first, the event path performs it. Multiple origin events, the initiating popup continuation, and later worker wakes all compete for the same state transition. Wake-only event cohorts never mix with explicit-nonce cohorts, so an unrelated permission event cannot borrow an explicit continuation's identity. Exactly one contender may change `armed` to `admitting`.

After that transition, the worker persists a durable job whose identity binds the handoff nonce and a `handoff_admitting` admission phase. For a nonce-bound handoff job, it also persists only the initiating popup `contextId` and capability SHA-256 digest needed to authenticate terminal `resumeArmedCleanup` replay by the surviving initiating popup across worker restart. The raw capability remains only in popup memory and never enters the review record, active job, report, or debug evidence. Only then may the worker remove the consumed session handoff and mark the job admitted. A crash or ambiguous failure at or after `admitting` does not recreate authority or automatically retry deletion; recovery uses the durable job identity and ordinary interrupted-job rules.

Exact lease-owned access is re-proved while the armed approval is consumed and twice after durable admission: before any start badge/debug-log presentation, then immediately before the first browser-data adapter. Losing or changing exact access at any checkpoint fails closed before the next observable or mutation-capable boundary.

## Invalidation, expiry, and settlement

A review expiry, target/source/private change, settings change, reset, capability-authenticated explicit cancellation, malformed state, or other authority mismatch before `admitting` creates `prompt_tombstone` whenever a native prompt may still be open. A missing or invalid capability cannot falsely claim that the prompt never started or explicitly settle another popup's handoff. Deleting a valid handoff immediately would forget ownership just before a late grant. The tombstone is permanently non-runnable and must never become `armed` again.

The tombstone persists across service-worker suspension, wake, and extension-page closure. It is retired only after exact prompt settlement permits strict reconciliation—including revocation of only the exact patterns classified temporary by that preflight—or after a real browser-session boundary establishes that the prior native prompt cannot still settle. A worker restart, extension-page reload, elapsed timer, broad grant, partial event, or failed/unknown permission query is not that boundary. Pre-existing and broader user-controlled access is never automatically removed; ambiguous removal preserves a visible recovery obligation.

The popup independently renders review expiry on a live timer, disables stale approval, announces the stale state, and performs a synchronous expiry check before invoking the permission request or dispatching arm. Those UI checks reduce confusion but do not replace the worker's full fail-closed validation.

## Preserved product boundaries

This handoff applies to both `detailed_review` and `settings_direct` final approvals, including Standard and Expert modes. It does not create a raw cleanup route, a caller-controlled skip flag, a durable reusable approval, or permission-derived intent. Direct mode remains one SiteWipe **Clean now** action; detailed mode retains its displayed review and distinct final approval; either may still be followed by a separate browser-controlled permission confirmation.

Private-source cleanup does not use this missing-access prompt flow. The browser must already have **Allow in incognito** enabled and every exact target pattern pregranted before private preflight can produce authority. The extension cannot enable incognito access and does not persist missing/temporary private target patterns.

The permission handoff does not change downloaded-file policy. Standard mode continues not to delete downloaded files. Expert downloaded-file deletion remains off by default, requires its existing saved setting and preflight-bound completed file IDs, and preserves files and browser records whenever live identity or outcome is uncertain.

## Consequences, source verification, and required evidence

The worker can finish an already authorized prompt-bound admission after Chrome destroys the popup, without converting permission possession, a copied context ID, or `permissions.onAdded` into intent. The context/capability pair recognizes the legitimate popup without depending on optional sender document metadata or a live popup query after native UI begins. The cost is a small pre-job state machine, a bounded context lookup and capability rotation protocol, a tombstone/reconciliation obligation, more lifecycle serialization, and a permanent no-retry boundary once admission begins.

The superseded 1.11.39 document-ID implementation had an independent adversarial source verdict with no concrete P0/P1 finding: routing 31/31, startup 42/42, focused handoff security 104/104, popup 22/22, and preflight/review/lease 57/57. Its full unit run was 486/487, with the sole expected failure being the pre-bump runtime/stable-input fingerprint mismatch. The installed run then proved that the mocks' unconditional popup `documentId` did not represent Chrome's valid sender shape. Those totals remain historical source facts, but they do not verify the accepted context/capability remediation or close SW-035.

The frozen 1.11.42 remediation had an independent audit verdict of PASS with no concrete P0/P1 finding. Focused checks passed 163/163 (`8+35+14+1+33+42+25+5`), with cleanup-mode/download checks at 10/10. The syntax scan passed across 433 files, and types, ESLint, Prettier, and diff checks passed. One isolated timing case reproduced only under concurrent runner contention, then passed in the 42/42 suite rerun and 10/10 exact-case rerun; the audit classified it as non-product harness contention. The subsequent installed run nevertheless proved that both the worker and mock had assigned the positive source browser-window ID to the action popup, while Chrome reports the popup's own `windowId` as `-1`. That source verdict remains historical evidence, not installed compatibility evidence. The current correction uses a canonical browser-shaped context fixture, worker-side static mutation guards, and a required new artifact/install gate.

The failed exact 1.11.38, 1.11.39, and 1.11.42 runs are historical failure evidence only. The exact current corrective candidate must be loaded into a fresh disposable, unsynced profile and retain machine-readable results for:

- popup preparation when `MessageSender.documentId` is absent; exact unique action-popup context acceptance with Chrome's `tabId`/`windowId` sentinels; independent source-window/private verification including spanning-profile separation; zero/multiple/wrong type/URL/context/sentinel rejection; unavailable/failed `getContexts()` rejection; raw-secret non-persistence; same-context response retry before handoff; pregranted rebind only after old-context absence; and missing-access cross-context conversion into a non-runnable reconciliation obligation rather than authority transfer;
- wrong/missing/replayed capability rejection plus nonce-bound active-job persistence of only context ID and capability digest for an authentic surviving popup's terminal replay across worker restart;
- the exact activation order—`permissions.request()` invocation first, immediate non-awaited arm dispatch in the same task, then the first await of the permission promise—with no arm-time live-context lookup;
- detailed and direct Standard/Expert exact grant, denial, dismissal/abandonment, popup destruction, and ordinary popup survival;
- `onAdded` before/after arm, multiple/partial origin events, broad-only access, manual grants without a handoff, popup/event duplicates, capability-authenticated denied/abandoned settlement and `promptNotStarted` cancellation, and permission removal before admission;
- expiry and settings/target/source/private/reset invalidation while the native prompt is open, late grant settlement, tombstone reconciliation, worker suspension/restart, and real browser-session-boundary handling;
- exactly one nonce-bound durable job/report, temporary exact-access release, no orphan handoff/lease/shield state, and no cleanup on every rejected path;
- target fixture deletion with sibling/lookalike/protected data unchanged, incognito off/on policy, and downloaded files preserved whenever deletion is disabled.

Source and synthetic Browser checks cannot close this installed-native-prompt gate. The focused independent source audit is complete, but until the complete validation/evidence transaction and exact-artifact run of the current corrective candidate pass, publication evidence remains pending.
