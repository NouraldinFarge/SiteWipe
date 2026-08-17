# Repository publication, CI, and security plan

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

This file records the repository's transition from private staging to public source on 2026-08-17. Public visibility and the named repository security controls are complete. That source-publication action does not create a tag, binary release, Pages deployment, Package, store submission, professional-profile approval, secret, or attestation.

## Stage 1: owner-selected destination — completed

The decision records identify `https://github.com/NouraldinFarge/SiteWipe`, maintainer `NouraldinFarge`, default branch `main`, the confirmed Git author identity, MIT, provenance approval, and first-upload authorization. Before the first push, the destination was verified private and empty. GitHub now recognizes the MIT license, and the source repository is public.

## Stage 2: first private upload — completed

Under the recorded first-private-upload authorization:

1. create the approved local commit(s) without fabricated dates/history;
2. add the exact approved remote;
3. fetch and inspect remote refs/default branch;
4. push only `main` to the private repository;
5. compare remote commit/tree with local source closure;
6. retain the push result and commit SHA privately.

Do not create a tag/release, change visibility, enable Pages, publish Packages, or upload release artifacts in this stage.

Completion evidence records root commit `29d0a6ea17701ab8892d36472d10120d9f61eb1b`, exact local/remote `main` parity after the first push, one approved remote, and zero tags/releases. Later remediation work was pushed only to `agent/fix-private-codeql` and opened as draft PR 1. The repository was then made public without creating a tag, binary, or release surface.

## Stage 3: least-privilege repository controls — verified for public source

With separately authorized repository-setting access, verify and record:

- default branch is `main`;
- direct pushes are restricted after bootstrap;
- pull requests are required where the account tier supports them;
- at least one approving review and CODEOWNER approval are required only after a second owner-approved, write-capable reviewer exists, because a pull-request author cannot self-approve;
- stale approvals are dismissed after relevant changes once independent review is enabled;
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

Live verification proves that `main` is the default branch, default workflow permissions are read-only, and every checked-in Action reference is pinned. The active dated evidence record binds exact-head CI, local/hosted artifact parity, CodeQL, retained SARIF, and SARIF result counts to the commit actually checked; every later head resets that proof until its own hosted runs complete. Selected Actions allow only GitHub-owned actions and require full commit SHA references. Branch protection requires the observed CI and CodeQL jobs, strict up-to-date branches, conversation resolution, linear history, and admin enforcement while disallowing force pushes and deletion. Dependency alerts, automated security fixes, secret scanning, push protection, private vulnerability reporting, and a protected release environment are enabled. The public policy Gist supplies the hosted policy and non-sensitive contact surface.

The checked-in CODEOWNERS entry records the owner-confirmed maintainer and routes responsibility; it does not prove independent review. Until a second owner-approved account with write access exists, protection does not require an approving or CODEOWNER review that the sole pull-request author cannot supply.

## Required checks proposed for protection

Use the exact job names observed on the approved remote; intended local definitions cover formatting, version contract, syntax/types/lint/HTML/CSS, manifest, remote-code/secret/license/notices/assets/docs/action pins/package closure, legacy/unit/property tests, coverage, build/verification, and CodeQL. Never mark them verified from YAML inspection alone.

The pinned CodeQL workflow runs the complete analysis, uploads results for the public repository, and retains SARIF evidence. Its least-privilege token includes read-only Actions metadata because the CodeQL action resolves the current workflow run. Every new head must produce its own successful result.

## Release path after later approvals

The manual candidate workflow must check out an exact reviewed commit, install with scripts disabled, run all checks and coverage, build twice, verify byte identity and source/runtime parity, evaluate publication gates after rebuild, generate checksums/SBOM/provenance input, and create a GitHub artifact attestation only in the approved environment. A tag/release, binary upload, store submission, and professional-surface edit remain separate gated actions.

## Rollback

If remote source or settings diverge, stop and preserve commit, workflow, and settings evidence. Do not change visibility or remove history merely to hide a failure. A compromised credential or confirmed private-data exposure requires incident handling and owner coordination, not an automatic destructive cleanup.
