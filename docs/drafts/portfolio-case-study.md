# DRAFT — NOT APPROVED FOR PUBLICATION: SiteWipe portfolio case study

## Working title

Designing a fail-closed consent boundary for destructive browser cleanup

## One-line summary

SiteWipe is a public-source Manifest V3 prerelease engineering project that explores how to review, authorize, constrain, recover, and report multi-API browser-data cleanup for one site boundary without claiming complete erasure.

## Problem

Chromium does not expose one uniform “delete this site” transaction. Cookies, origin storage, open tabs, history, downloads, injected page APIs, host permissions, request-blocking rules, service-worker lifetime, and verification all use different scopes and failure semantics. A convenient primary button can therefore become dangerous unless the same normalized authority survives every boundary.

## Engineering response

- Bundled and pinned the full Public Suffix List, including PRIVATE tenant rules, with fail-closed unknown/public-suffix behavior and exact local-origin support.
- Split work into a read-only preflight and a preflight-bound authorization transaction. Detailed review remains the default in Standard and Expert; an explicitly warned, default-off direct setting prepares the same hidden snapshot/lease before one SiteWipe action. Older quick/bypass messages and unbound session records remain rejected.
- Bound a random, five-minute, single-use approval to target, settings, associated scope, browser context, impacts, permission ownership, acknowledgements, and completed file IDs, then independently revalidated detailed-review mode before orchestration.
- Added per-adapter target checks and fresh origin/tab/file revalidation instead of trusting preview data as mutation authority.
- Preserved interruption responsibility with durable temporary-permission leases and persist-before-mutate DNR recovery records.
- Represented verification as exposed evidence states—zero, residue, unsupported, timeout, failure, unknown—rather than a universal “clean” result.
- Centralized report redaction and short retention, including private-context persistence refusal and deterministic startup/migration expiry.
- Treated release integrity as part of safety: explicit source/runtime closures, deterministic archives, byte parity, checksums, SBOM, version fingerprints, and evidence reset on every stable change.

## Validation position

The local project includes unit, stateful Chrome-API mock, fixed-seed property, official PSL corpus, accessibility-contract, static-analysis, package-integrity, and deterministic-build checks. Exact counts and coverage must be inserted only from the final retained validation record. Installed Chrome/Brave, accessibility, performance, media, remote CI/security, license/provenance, and publication evidence remain open; this case study must not be published while those gates are open.

## What I would discuss in an interview

- why PRIVATE suffixes change the tenant boundary;
- why a permission prompt is capability consent but not destructive-action consent;
- how consume-before-mutate and independent authorization checks reduce alternate-route risk;
- why timeouts are unknown outcomes rather than failures or zeros;
- how MV3 worker suspension changes recovery ownership;
- why exact-origin cookie scope is a documented exception;
- why a deterministic build and honest claim ledger matter for a safety-sensitive portfolio project;
- how substantial AI assistance was treated as untrusted input and checked with adversarial evidence.

## Technology wording

Production runtime: JavaScript, HTML, CSS, Chrome Manifest V3 APIs. Development and quality tooling: Node.js, TypeScript JavaScript checking/JSDoc, ESLint, c8, fast-check, accessibility contracts, and deterministic packaging. Do not present this project as a React or production-TypeScript application.
