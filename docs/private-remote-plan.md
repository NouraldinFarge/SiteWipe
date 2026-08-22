# Private remote, CI, and security plan

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

Historical plan: this file records the original private-staging transition and must not be followed as a current publication procedure. The repository is now publicly and anonymously reachable. The dated audit linked below remains historical evidence; current candidate and remote facts live in the release-readiness ledger and `remote-publication.json`.

This plan does not grant authority by itself. The owner separately authorized creation of `NouraldinFarge/SiteWipe` as a private repository and its first truthful push on 2026-08-17. No public visibility, tag, release, Pages site, Package, store submission, professional-profile publication, setting change, secret, or attestation is authorized by that approval.

## Stage 1: owner-selected destination

The decision records identify `https://github.com/NouraldinFarge/SiteWipe`, maintainer `NouraldinFarge`, default branch `main`, the confirmed Git author identity, MIT, provenance approval, and first-upload authorization. Confirm at action time that the destination is private and empty before adding it as a remote.

## Stage 2: first private upload

Under the recorded first-private-upload authorization:

1. create the approved local commit(s) without fabricated dates/history;
2. add the exact approved remote;
3. fetch and inspect remote refs/default branch;
4. push only `main` to the private repository;
5. compare remote commit/tree with local source closure;
6. retain the push result and commit SHA privately.

Do not create a tag/release, change visibility, enable Pages, publish Packages, or upload release artifacts in this stage.

## Stage 3: least-privilege repository controls

With separately authorized repository-setting access, verify and record:

- default branch is `main`;
- direct pushes are restricted after bootstrap;
- pull requests and at least one approving review are required where account tier supports them;
- stale approvals are dismissed after relevant changes;
- conversation resolution is required;
- required status checks use the exact workflow job names that actually run;
- branches must be current before merge;
- force pushes and branch deletion are disabled;
- administrators are covered where supported and an emergency path is documented;
- Actions permissions are limited to the checked-in pinned workflows;
- workflow permissions default to read-only, with narrowly scoped `id-token: write` only for an explicitly approved attestation job;
- CodeQL runs successfully on JavaScript/TypeScript source and the expected branch/event;
- private vulnerability reporting is enabled and the confidential route works;
- Dependabot/security alerts and dependency review are configured only after reviewing notification/privacy implications;
- a protected manual release environment exists, has required reviewer(s), and exposes no unreviewed secrets to pull-request code;
- the stable privacy-policy URL and security contact are recorded only after they are actually hosted and inspected.

## Required checks proposed for protection

Use the exact job names observed on the approved remote; intended local definitions cover formatting, version contract, syntax/types/lint/HTML/CSS, manifest, remote-code/secret/license/notices/assets/docs/action pins/package closure, legacy/unit/property tests, coverage, build/verification, and CodeQL. Never mark them verified from YAML inspection alone.

## Release path after later approvals

The manual candidate workflow must check out an exact reviewed commit, install with scripts disabled, run all checks and coverage, build twice, verify byte identity and source/runtime parity, evaluate publication gates after rebuild, generate checksums/SBOM/provenance input, and create a GitHub artifact attestation only in the approved environment. A public tag/release, visibility change, store submission, and professional-surface edits each remain separate owner actions.

## Rollback

If remote source or settings diverge, stop; preserve commit/workflow/settings evidence; return the repository to private if and only if separately authorized and technically possible; remove no history or evidence merely to hide a failure. A compromised credential or unexpected public exposure requires incident handling and owner coordination, not an automatic destructive cleanup.
