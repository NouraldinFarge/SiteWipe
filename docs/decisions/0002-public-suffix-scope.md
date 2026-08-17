# ADR 0002: Use a pinned complete Public Suffix List for destructive scope

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

- Status: Accepted
- Date: 2026-08-16

## Context

The baseline handwritten suffix subset collapsed PRIVATE hosted tenants such as `alice.blogspot.com` to a shared platform domain and mishandled wildcard/exception/multi-level rules. For destructive operations, a false parent boundary can affect unrelated users.

## Decision

Bundle a version-pinned complete Public Suffix List snapshot with ICANN and PRIVATE rules. Parse exact, wildcard, and exception rules locally; canonicalize Unicode through URL/IDNA behavior; return no registrable domain for unknown suffixes or public-suffix-only inputs. Preserve exact scheme/host/port for explicitly enabled localhost/IP targets. Normalize associated scopes independently.

No suffix data is downloaded at runtime. The controlled developer update script records upstream timestamp, commit, SHA-256, license, generated output, and corpus fixture, after which every domain/scope test must pass.

## Alternatives considered

1. Expand the handwritten list: rejected because it remains incomplete and silently ages.
2. Use exact host/origin for every normal site: safer but materially changes intended subdomain cleanup and cookie semantics.
3. Fetch PSL at runtime: rejected for privacy, availability, reviewability, and remote-input risk.
4. Add an unreviewed runtime npm resolver: rejected; the small local parser plus licensed data preserves zero runtime dependencies and auditable behavior.

## Consequences

The runtime grows because it bundles the list and must receive reviewed updates. A stale snapshot can miss new suffixes, so unknowns fail closed. Automated evidence includes the official conformance corpus and cross-adapter sibling invariants; browser fixture evidence remains required.
