# Honest Git history plan

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

Historical plan: the zero-commit/private-staging facts below describe the repository before its first commit and upload. Current alignment and availability evidence is recorded in [`docs/evidence/github-settings-audit-2026-08-17.json`](./evidence/github-settings-audit-2026-08-17.json).

Fact pattern when this plan was approved: local branch `main`, zero commits, zero remotes, zero tags, and all candidate paths untracked. The outer working container is not a repository and must never become part of this history. The owner separately authorized one truthful initial candidate commit and the first push to the named private staging repository; this document does not authorize later public or release actions.

## Preconditions for the first commit

- Owner selected MIT and the required root `LICENSE` is hash-bound to the decision record and package metadata.
- Owner confirmed copyright/authorship, substantial AI assistance, icon/asset rights, third-party notices, dependency inventory, and private-material exclusions.
- Git author name/email are explicitly confirmed as `Nouraldin Farge <144660662+NouraldinFarge@users.noreply.github.com>`.
- The synchronized candidate version, complete local check, coverage, double build, archive parity, checksums, SBOM, and publication-blocker snapshot are retained.
- A source-closure preview confirms no outer-container path, archive, profile, transcript, secret, private URL, or personal fixture enters Git.
- Owner gave explicit permission to create the first local commit and initial private staging push on 2026-08-17.

## Proposed reviewable commits

Because there is no genuine earlier history, do not fabricate chronological development commits. Prefer a small truthful bootstrap series created on the actual approval date:

1. `chore: establish private SiteWipe candidate source closure`
   - project configuration, manifest, deterministic build/release scripts, third-party notices/data, baseline documentation, and non-secret assets;
2. `feat: add guarded site-scoped cleanup runtime`
   - runtime modules and UI as one auditable product implementation;
3. `test: add safety privacy and release evidence contracts`
   - unit/property/fixture/static/release tests and machine evidence templates;
4. `docs: document consent boundaries risks and publication gates`
   - architecture, ADRs, privacy, permission, safety, claim, owner, store, and recruiter drafts.

If separating the initial snapshot would make byte provenance harder to review, one honest initial commit is preferable: `chore: establish private SiteWipe release candidate`. Commit messages must not claim public release, store availability, owner approval, or historical dates.

## Verification before each commit

- Review the exact staged path list and staged diff.
- Re-run secret/private-path/source-closure checks against staged content.
- Ensure generated artifacts, `dist/`, coverage, browser profiles, local evidence containing machine/private values, and the outer container remain excluded.
- Record the actual command results and candidate artifact hashes; never amend evidence to match a desired result.

## Remote alignment after separate approval

Create or select only the owner-approved private repository, confirm its empty/default state, add it with an explicit URL, fetch before pushing, and push the reviewed branch only after action-time approval. Do not force-push, rewrite published history, create public tags, or make the repository public as part of the first upload. Remote settings and workflow runs require independent verification described in [`private-remote-plan.md`](./private-remote-plan.md).
