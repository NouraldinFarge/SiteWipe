# Disposable browser fixture

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

This loopback-only fixture seeds synthetic browser data without touching a daily profile. It is fixture infrastructure, not retained Chrome/Brave evidence and not a browser automation result.

Start it with `npm run browser:fixture`. The default endpoint is `http://127.0.0.1:43819`. A disposable browser launch may map these synthetic hosts to `127.0.0.1` without editing the operating-system hosts file:

- `selected.example.com` and `sub.selected.example.com` for registrable/subdomain behavior;
- `selected.example.com.evil.invalid` for lookalike rejection;
- `alice.blogspot.com` and `bob.blogspot.com` for PRIVATE-suffix sibling isolation;
- `chips.localhost` for a third-party partitioned-cookie attempt;
- `127.0.0.1` on two ports for exact-origin scheme/port checks.

Use `?scale=small`, `?scale=medium`, or `?scale=large`; these seed 8, 64, or 256 bounded records in localStorage, sessionStorage, IndexedDB, and Cache Storage where supported. Add `&autoseed=1`; add `&embed=1` to include and automatically seed the `chips.localhost` frame. The page also attempts service-worker, Storage Bucket, and OPFS fixtures only when the browser exposes those APIs and provides a harmless synthetic download.

### Non-reseeding partition-preservation probe

Use two distinct URLs for a valid before/after check of the embedded `chips.localhost` fixture. Before cleanup, open `http://selected.example.com:43819/?scale=small&autoseed=1&embed=1` to seed the target origin and the embedded partition. After cleanup, do **not** reopen that seed URL. Open `http://selected.example.com:43819/partition-probe?scale=small` instead.

The `/partition-probe` route embeds `http://chips.localhost:43819/partition-probe/frame` under the same top-level scheme, site, and port, then automatically snapshots the child's existing exposed state. Neither probe route includes or honors `autoseed=1`, and their controls for seeding, resetting, and downloading are suppressed. This makes a nonzero embedded result evidence of preserved pre-clean fixture state rather than data recreated by the verification page. Keep the top-level scheme, registrable site, and fixture port identical between the seed and probe visits so the browser uses the same partition key. Treat unsupported or unexposed browser surfaces as limits rather than zero results.

## Synthetic SiteWipe UI routes

The same loopback server can render SiteWipe's production popup, Options, and side-panel documents with surface-specific synthetic browser-API mocks injected before their production modules. These routes are intended for ChatGPT in-app Browser layout, responsive, semantics, keyboard/focus, and copy review:

| Surface    | Route                       | Synthetic state controls                                                                                                                                                                                                                                                                                                |
| ---------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Popup      | `/popup/popup.html`         | `mode=standard`, `direct=1`, `private=1`, `pregranted=1`, `transient=1`, `permission=deny`, `permission=expire-after-grant`, `active=unsupported`, `overlay=off`, and `zoom=200` or `zoom=400`; combine controls with `&`                                                                                               |
| Options    | `/options/options.html`     | `load=fail-once` exercises fail-closed hydration and retry; otherwise uses synthetic settings, storage, private-access, permission, backup, and active-job responses; resize the Browser viewport to inspect responsive section navigation                                                                              |
| Side panel | `/sidepanel/sidepanel.html` | `view=report`, `view=matrix`, `view=history`, or `view=privacy`; `width=220..700`; `verification=verified-zero`, `residue-incomplete`, or `incomplete-zero`; `matrixSearch=...`; `matrixStatus=all`, `supported`, `partial`, or `unavailable`; `history=empty`; `stored=full`; and `outcome=warning` or `runtime-error` |

For example, `http://127.0.0.1:43819/popup/popup.html?mode=standard` exercises the full synthetic missing-permission handoff and a deterministic completed Standard report. `http://127.0.0.1:43819/popup/popup.html?mode=standard&permission=expire-after-grant` keeps the review usable until the synthetic permission request, then returns a grant after expiring the same prepared review and rejecting its arm operation. The production popup must show **Cleanup review expired**, report that no cleanup started, confirm temporary target access was released, and require a fresh review; the fixture counters must show one prompt settlement and zero approved runs. These are simulated message and permission results, not a native browser prompt or privileged cleanup.

The `direct=1&private=1&transient=1` combination exercises transient private-report actions, `http://127.0.0.1:43819/options/options.html?load=fail-once` exercises locked hydration recovery, and `http://127.0.0.1:43819/sidepanel/sidepanel.html?view=report&width=320&verification=residue-incomplete` exercises known residue with an unknown full total. All values and reports in these mocks are synthetic; `stored=full` exposes only the fixture's invented detail strings.

These pages do **not** load the runtime ZIP or run at a `chrome-extension://` origin. They do not exercise privileged cleanup APIs, native permission prompts, real private-window spanning, MV3 worker suspension/restart, installed-extension performance, Chrome/Brave compatibility, or authentic release media. Record any observations as **synthetic in-app UI evidence** only; never use them to populate or approve installed Chrome, Brave, accessibility, exact-artifact performance, destructive-operation, incognito, compatibility, or store-media fields.

The test operator must record the exact host-resolver configuration, browser/profile versions, final artifact SHA-256, fixture URL/scale, unsupported APIs, and before/after controls in `docs/evidence/browser-validation.json`. HTTP aliases are not secure contexts; secure-only surfaces must be validated on loopback/localhost and reported separately. Never weaken browser security flags merely to convert an unsupported fixture into a pass.
