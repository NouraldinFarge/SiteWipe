# ADR 0007: Prohibit MAIN-world destructive page scripts

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

- Status: Accepted
- Date: 2026-08-16

## Context

JavaScript running in a page's MAIN world shares globals with hostile page code. A site can replace storage/service-worker APIs, change arguments, trigger side effects, or return fabricated evidence.

## Decision

Run live-page cleanup and progress code in the extension's isolated scripting world. Force the migrated `mainWorldPageScrub` setting to `false` in policy code so an old profile cannot reactivate the retired path. Repeat target matching inside the injected function, including exact-origin scheme/port and PRIVATE-tenant boundaries.

## Consequences

Some page-only APIs or state may not be accessible, so live-page cleanup remains partial/best effort and reports limitations. This tradeoff is preferred to granting the target page influence over destructive logic or evidence.
