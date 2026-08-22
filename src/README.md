# Runtime source

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

This directory is the unpacked Manifest V3 runtime root. `manifest.json` is intentionally at this level, and the deterministic loadable ZIP maps the allowlisted contents of this directory to the archive root.

`SiteWipe` is the owner-approved custom product identity, and MIT is the owner-approved first-party project license. Known exact-name browser-extension listings mean uniqueness and legal clearance are not claimed. Version `1.11.46` is a public-source prerelease; it must not be represented as a supported binary or submitted to a browser store before its remaining gates pass.

Use the repository-level [`README.md`](../README.md) for architecture, safety boundaries, permissions, validation status, and local-review instructions. The evidence registry and release-readiness ledger under [`docs/`](../docs/) are authoritative for public claims.

Do not load this extension in a daily browser profile. Use a disposable Chrome or Brave profile with synthetic test data. Detailed scope-and-impact review is the default in Standard and Expert. The explicitly confirmed, default-off **Skip detailed cleanup review completely** setting enables `settings_direct` in either mode: SiteWipe completes a hidden fresh preflight and durable permission lease before enabling **Clean now**, then one SiteWipe activation may open a separate native permission prompt and submits the same single-use cleanup route. Verify default/direct behavior, truthful reports, the preflight-bound target/settings/private/access/impact/file IDs, and temporary site-access recovery after cancellation, abandonment, denial, failure, worker termination, and restart. Private-source direct runs additionally require browser-controlled **Allow in incognito** and pre-existing exact target access.
