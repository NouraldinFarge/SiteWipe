# Security Policy

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

There is no supported public release yet. Security review currently applies to the private `1.11.4` candidate and its locally generated artifacts only.

## Reporting a vulnerability

Do not disclose a suspected vulnerability, real browsing history, cookies, tokens, local paths, download filenames, extension IDs, or private-window activity in a public issue.

The repository remote and private vulnerability-reporting channel have not yet been created. That missing confidential contact route is a publication blocker. Once the intended GitHub repository exists, the owner must enable GitHub Private Vulnerability Reporting and update this file with the exact verified route before issues are opened to the public.

Until then, report only through a private channel explicitly supplied by the project owner. If no such channel has been supplied, retain the report locally and notify the owner that confidential intake is unavailable; do not guess an email address.

## Useful report contents

- a concise impact statement;
- affected source commit or artifact SHA-256;
- browser and operating-system versions;
- synthetic reproduction steps in a disposable profile;
- whether the issue crosses a reviewed target boundary, runs before approval, loses recovery state, leaks a redaction canary, or misstates verification evidence;
- the smallest safe diagnostic excerpt.

Use synthetic domains and filenames. Start from a redacted troubleshooting export, inspect it, and remove anything unnecessary. Never attach a real browser profile or unredacted report.

## Priority areas

- registrable-domain, private-suffix, exact-origin, associated-target, or lookalike scope expansion;
- any destructive API call before valid approval;
- approval-state tampering, stale/cross-context message acceptance, or loss/misclassification of a temporary host-permission lease;
- on-disk file deletion not bound to reviewed completed IDs;
- request-shield rules that survive without tracked recovery state;
- report, debug, support, or export redaction leaks;
- false zero-residue or high-confidence outcomes after failed/unknown verification;
- message spoofing, malformed stored state, remote executable code, or permission escalation;
- private-context persistence.
- stale release selection or browser/performance/accessibility evidence attached to artifact bytes that were not actually tested.

## Coordinated handling

The owner should acknowledge a valid private report, reproduce it with synthetic data, preserve evidence, and agree on disclosure timing before publication. No response-time or fix-time SLA is promised while the project remains an unpublished private candidate.

Security fixes must add a regression test where feasible, rerun all local gates, repeat installed Chrome/Brave validation when browser behavior is involved, rebuild deterministic artifacts, and invalidate any earlier checksum.

## Security boundaries

Checksums are not signatures. Redaction is not anonymization. Browser-visible verification is not proof of complete erasure. The extension cannot control remote, operating-system, enterprise, synchronized, or unexposed browser state.
