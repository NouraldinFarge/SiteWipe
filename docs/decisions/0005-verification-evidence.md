# ADR 0005: Model verification as explicit evidence states

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

- Status: Accepted
- Date: 2026-08-16

## Context

The baseline could coerce a failed/unknown category to zero and still report High confidence with “no exposed residue.” That conflated cleanup completion with verification certainty.

## Decision

Represent each required check as `verified_zero`, `residue_found`, `not_supported`, `not_attempted`, `timed_out`, `failed`, or `unknown`. “No exposed residue found” is available only when every required category completed and returned zero. Any incomplete verification caps the evidence score; runtime or origin-cleanup failures prevent a High label even after zero results. Browser limitations and runtime errors remain separate report concepts.

## Alternatives considered

- Use numeric counts with `null` converted to zero: rejected as misleading.
- Remove all summary scoring: considered; retained temporarily because the UI explains reasons and labels it evidence confidence, not deletion proof. Revisit after user research.
- Treat unsupported categories as success: rejected because absence of an API is not evidence of absence.

## Consequences

Reports can finish cleanup with partial verification and lower confidence. The verifier covers only exposed cookies, tabs, history URLs, and download records; zero on those surfaces does not prove complete deletion.
