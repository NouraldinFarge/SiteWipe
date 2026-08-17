# Private remote, CI, and security plan

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

This plan does not grant authority by itself. The owner separately authorized creation of `NouraldinFarge/SiteWipe` as a private repository and its first truthful push on 2026-08-17. The owner later authorized the named repository security controls and a public privacy-policy Gist, including an immediate public-only control pass after a separately approved visibility change. Neither authorization permits public visibility, merging, tags, releases, Pages, Packages, store submission, professional-profile publication, secrets, or attestation.

## Stage 1: owner-selected destination — completed

The decision records identify `https://github.com/NouraldinFarge/SiteWipe`, maintainer `NouraldinFarge`, default branch `main`, the confirmed Git author identity, MIT, provenance approval, and first-upload authorization. Before the first push, the destination was verified private and empty. GitHub now recognizes the MIT license, and the remote remains private.

## Stage 2: first private upload — completed

Under the recorded first-private-upload authorization:

1. create the approved local commit(s) without fabricated dates/history;
2. add the exact approved remote;
3. fetch and inspect remote refs/default branch;
4. push only `main` to the private repository;
5. compare remote commit/tree with local source closure;
6. retain the push result and commit SHA privately.

Do not create a tag/release, change visibility, enable Pages, publish Packages, or upload release artifacts in this stage.

Completion evidence records root commit `29d0a6ea17701ab8892d36472d10120d9f61eb1b`, exact local/remote `main` parity after the first push, one approved remote, and zero tags/releases. Later remediation work was pushed only to `agent/fix-private-codeql` and opened as draft PR 1; it did not alter public visibility or create a release surface.

## Stage 3: least-privilege repository controls — partially complete

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

Live verification proves that `main` is the default branch, default workflow permissions are read-only, and every checked-in Action reference is pinned. Prior candidate `1.11.8` passed exact-head CI and CodeQL, private SARIF retention worked, and the remediated SARIF contained zero findings; every later exact head, including the current candidate, still requires a fresh hosted run after its private push. The repository now uses the selected-Actions policy, requires full commit SHA references, allows GitHub-owned Actions while rejecting the verified-creator category, and has dependency alerts plus automated security fixes enabled. The current private account tier still rejects branch protection and rulesets unless the owner upgrades to GitHub Pro or makes the repository public; per-action patterns, private vulnerability reporting, and protected release environments also remain unavailable in the present private/free-plan state. The public policy Gist supplies only the hosted policy and non-sensitive contact surface, not the still-pending confidential reporting route.

The checked-in CODEOWNERS entry records the owner-confirmed maintainer and routes responsibility; it does not prove independent review. Until a second owner-approved account with write access exists, protection must not require an approving or CODEOWNER review that the sole pull-request author cannot supply. Required CI/CodeQL, current-branch, conversation-resolution, no-force-push, and no-deletion rules must be applied immediately after separately authorized public visibility makes them available.

## Required checks proposed for protection

Use the exact job names observed on the approved remote; intended local definitions cover formatting, version contract, syntax/types/lint/HTML/CSS, manifest, remote-code/secret/license/notices/assets/docs/action pins/package closure, legacy/unit/property tests, coverage, build/verification, and CodeQL. Never mark them verified from YAML inspection alone.

Private staging may not have GitHub code-scanning ingestion enabled. In that state, the pinned CodeQL workflow must still run the complete analysis and retain its SARIF as a short-lived private Actions artifact, without claiming Security-tab ingestion. Its least-privilege token includes read-only Actions metadata because the CodeQL action resolves the current workflow run. When repository visibility and GitHub feature availability permit code-scanning ingestion, the same workflow uploads the SARIF and waits for processing; that remote result must be verified separately.

## Release path after later approvals

The manual candidate workflow must check out an exact reviewed commit, install with scripts disabled, run all checks and coverage, build twice, verify byte identity and source/runtime parity, evaluate publication gates after rebuild, generate checksums/SBOM/provenance input, and create a GitHub artifact attestation only in the approved environment. A public tag/release, visibility change, store submission, and professional-surface edits each remain separate owner actions.

## Rollback

If remote source or settings diverge, stop; preserve commit/workflow/settings evidence; return the repository to private if and only if separately authorized and technically possible; remove no history or evidence merely to hide a failure. A compromised credential or unexpected public exposure requires incident handling and owner coordination, not an automatic destructive cleanup.
