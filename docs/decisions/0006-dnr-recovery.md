# ADR 0006: Persist request-shield recovery intent before mutation

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

- Status: Accepted
- Date: 2026-08-16

## Context

An MV3 worker can terminate while `updateSessionRules` is in flight. Clearing a local record immediately after requesting DNR removal can lose the only visible recovery intent even when the API is unavailable, times out, or leaves a rule installed.

## Decision

Reserve DNR session rule IDs `730000–730499`. Persist an `installing` record before calling Chrome. Treat timeouts as lifecycle `unknown`. Clear the complete owned range, then inspect it; forget the record only when the API is available, no error occurred, and zero owned IDs remain. If diagnostics find owned rules without a valid record, reconstruct an unknown orphan record for later repair.

Recovery may change only SiteWipe-owned rule IDs and extension-local state. It never resumes browser-data deletion automatically.

## Consequences

Uncertain records may remain visible until a later successful retry, which is safer than a false clean state. The design depends on a stable, exclusive ID range and installed-browser interruption testing before release.
