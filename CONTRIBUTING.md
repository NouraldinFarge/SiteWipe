# Contributing

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

The first-party source is MIT-licensed and intended for public review, but external contribution intake remains paused while anonymous repository access returns `404`, the maintenance commitment is unresolved, and installed-browser evidence is incomplete. Reproducible issue reports must use synthetic data; suspected vulnerabilities must use the confidential route in [`SECURITY.md`](./SECURITY.md). These rules document the engineering standard for every local and proposed change.

## Setup

Use Node.js 24 or later and npm 11 or later.

```powershell
npm ci --ignore-scripts
npm run check
npm run test:coverage
```

Development dependencies are locked. The extension itself has zero npm runtime dependencies and no compilation step; `src` is the reviewed runtime source.

## Safety rules

- Treat all code—including AI-generated code—as untrusted until reviewed and tested.
- Never add global or time-based browsing-data deletion.
- Never add password, passkey, bookmark, Sync/account, autofill, or payment-data cleanup.
- Never weaken Public Suffix List or exact-origin boundaries to make a test pass.
- Never run destructive tests in a daily browser profile or against real personal data.
- Never put secrets, profiles, reports, internal prompts, historic archives, or local absolute paths in the repository.
- Never clear a DNR recovery record until diagnostics prove the complete owned range empty.
- Never convert a missing, failed, timed-out, skipped, unsupported, or unknown check to zero.
- Do not add runtime downloads, analytics, telemetry, remote code, or third-party services without a new threat model and explicit owner approval.

## Change workflow

1. State the intended safety boundary and failure behavior.
2. Add or update characterization and adversarial tests first for scope, deletion, redaction, verification, or recovery changes.
3. Keep Chrome API calls behind small adapters and preserve bounded work, timeouts, and explicit partial outcomes.
4. Add an `Unreleased` changelog entry and run `npm run version:bump -- patch` for every runtime change. Use `minor`, `major`, or an explicit forward-only `x.y.z` only when the change warrants it.
5. Run formatting, version, syntax, type, lint, HTML, CSS, manifest, remote-code, package-allowlist, legacy, unit, property, and coverage checks.
6. For browser-facing changes, use synthetic fixtures in disposable Chrome and Brave profiles and retain the browser version and evidence.
7. Update the relevant ADR, safety case, capability matrix, and claim-evidence row.
8. Rebuild and re-verify artifacts only after the source is final.

## Version discipline

Do not edit copied version strings by hand. `npm run version:bump -- patch` updates the root and source package metadata, lockfile, extension manifest, runtime constant, self-test, current documentation, changelog heading, artifact names, and evidence records together. It also records a SHA-256 fingerprint of the complete runtime allowlist.

`npm run check:version` is part of `npm run check`, the candidate builder, and artifact verification. It rejects mismatched version copies and any allowlisted runtime byte change that was not followed by a deliberate bump. The builder refreshes hashes for the current deterministic artifact, but it never increments the semantic version; rerunning an unchanged build must produce the same files.

## Code style

- Vanilla JavaScript ES modules; no runtime framework.
- Prefer pure normalization and matching functions over browser-dependent logic.
- Validate every message and stored record at trust boundaries.
- Preserve exact scheme/host/port for local targets; preserve host-scoped cookie limitations explicitly.
- Keep injected functions self-contained and in the isolated extension world.
- Use plain, evidence-aware language in UI and documentation.

## Tests

Tests must include normal, unavailable API, exception, partial-failure, timeout/unknown, and interrupted-state cases where applicable. Domain changes require official PSL corpus coverage plus private-tenant, wildcard, exception, IDN, punycode, trailing-dot, lookalike, unknown-TLD, local/IP, associated-target, and sibling-isolation cases.

Installed-browser evidence must use synthetic data. Static `file://` renders are not valid extension integration evidence.

## AI-assisted changes

Disclose material AI assistance in the change description. Review generated code line by line, verify third-party provenance, and do not attribute AI output to a human author who did not review it.

## Commits and pull requests

Keep changes focused and explain user impact, safety impact, tests, browser evidence, and documentation changes. A pull request may not publish artifacts or use release credentials. Public release remains a separately approved, manually gated action.
