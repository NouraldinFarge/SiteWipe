# ADR 0004: Historical complete cleanup-review bypass

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Superseded and removed by [ADR 0009](./0009-mandatory-cleanup-review.md)
- Original date: 2026-08-16
- Retirement date: 2026-08-17

## Historical context

An earlier private candidate implemented an owner-requested, off-by-default setting that skipped SiteWipe's per-run detailed cleanup screen in Standard and Expert modes. It retained a read-only preflight and single-use token, but it did not show or separately confirm the exact associated targets, private scope, protected/PWA effects, persistent request shield, incomplete counts, or irreversible downloaded-file effects for that run.

The setting was never publication-approved. A browser-controlled host-permission prompt could not repair the consent gap because such a prompt describes host access, not the browser data and files SiteWipe was about to change.

## Superseding decision

The bypass implementation, UI setting, import behavior, message mode, approval eligibility, and stored-preflight schema were removed. Legacy settings are dropped during normalization and migration. Legacy approval records use an older schema and are invalidated. Every current Standard or Expert run must display the complete fresh scope-and-impact review and receive its explicit final activation.

The historical approval record remains at `complete-review-bypass-approval.json` with `status: not_applicable_retired`, false approval fields, and no artifact binding. It is retained to prove that removal—not fabricated owner approval—closed the consent defect.

## Consequences

- There is no current streamlined, quick, bypass, or single-activation cleanup path.
- Initial target submission performs only preparation and renders the review.
- Final review approval is the only UI route that can request missing target access and submit cleanup.
- Message, review, preflight, and authorization boundaries independently reject non-`detailed_review` modes.
- Reintroducing a bypass requires a new safety decision, implementation review, regression suite, installed-browser evidence, and explicit owner decision; the publication gate also scans critical runtime files for retired signals.

This record describes history only and must not be used as current product documentation.
