# Runtime source

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

This directory is the unpacked Manifest V3 runtime root. `manifest.json` is intentionally at this level, and the deterministic loadable ZIP maps the allowlisted contents of this directory to the archive root.

`SiteWipe` is the owner-approved custom product identity. Known exact-name browser-extension listings mean uniqueness and legal clearance are not claimed. Version `1.11.3` remains a private candidate; no public version or project-level license has been approved, and this candidate must not be published or submitted to a browser store.

Use the repository-level [`README.md`](../README.md) for architecture, safety boundaries, permissions, validation status, and local-review instructions. The evidence registry and release-readiness ledger under [`docs/`](../docs/) are authoritative for public claims.

Do not load this extension in a daily browser profile. Use a disposable Chrome or Brave profile with synthetic test data. Every Standard and Expert cleanup must display a fresh detailed scope-and-impact review and require a final explicit activation. Verify that requirement, the visible normalized target, and temporary site-access recovery after cancellation, permission denial, failure, worker termination, and restart.
