# Disposable browser fixture

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

This loopback-only fixture seeds synthetic browser data without touching a daily profile. It is fixture infrastructure, not retained Chrome/Brave evidence and not a browser automation result.

Start it with `npm run browser:fixture`. The default endpoint is `http://127.0.0.1:43819`. A disposable browser launch may map these synthetic hosts to `127.0.0.1` without editing the operating-system hosts file:

- `selected.example.com` and `sub.selected.example.com` for registrable/subdomain behavior;
- `selected.example.com.evil.invalid` for lookalike rejection;
- `alice.blogspot.com` and `bob.blogspot.com` for PRIVATE-suffix sibling isolation;
- `chips.localhost` for a third-party partitioned-cookie attempt;
- `127.0.0.1` on two ports for exact-origin scheme/port checks.

Use `?scale=small`, `?scale=medium`, or `?scale=large`; these seed 8, 64, or 256 bounded records in localStorage, sessionStorage, IndexedDB, and Cache Storage where supported. Add `&autoseed=1`; add `&embed=1` to include the `chips.localhost` frame. The page also attempts service-worker, Storage Bucket, and OPFS fixtures only when the browser exposes those APIs and provides a harmless synthetic download.

The test operator must record the exact host-resolver configuration, browser/profile versions, final artifact SHA-256, fixture URL/scale, unsupported APIs, and before/after controls in `docs/evidence/browser-validation.json`. HTTP aliases are not secure contexts; secure-only surfaces must be validated on loopback/localhost and reported separately. Never weaken browser security flags merely to convert an unsupported fixture into a pass.
