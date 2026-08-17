# Release process

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

There is no approved public release process execution yet. These steps are designed to produce a reviewable candidate; they do not authorize publishing, pushing, tagging, creating a GitHub Release, portfolio use, or store submission.

## Human prerequisites

Before the first public release, the owner must approve and record:

- the owner-selected product identity, known name-collision/legal disposition, and exact public version;
- the project license/source-availability model and ownership assertions;
- icon/media provenance and every third-party notice;
- the intended GitHub remote, maintainer/contact routes, and public issue policy;
- disposable Chrome and actual Brave validation evidence;
- benchmark and accessibility evidence;
- hosted privacy policy and store disclosure answers;
- final publication, store-submission, and portfolio approval.

## Local candidate build

For every runtime change, first add an `Unreleased` changelog entry and perform one deliberate version transaction from the clean repository root:

```powershell
npm run version:bump -- patch
```

The command accepts `minor`, `major`, or an explicit forward-only `x.y.z` in place of `patch`. It stages every version/document/evidence change, refreshes the dependency-inventory lockfile hash, writes a recovery journal, promotes the complete set, and records separate reviewed fingerprints for the runtime and every stable release input. The stable-input contract covers source, scripts, CI, tests, documentation, configuration, assets, lockfile, and third-party material. Mutable post-build evidence and owner-approval JSON are explicitly excluded to prevent circular invalidation. An interrupted uncommitted transaction rolls back on the next run; a committed transaction finishes cleanup. The bump also resets browser, performance, and installed-accessibility results to pending for the new artifact. Do not update version copies or evidence bindings individually.

Then validate and build:

```powershell
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm audit --audit-level=moderate
npm run build:release-candidate
npm run verify:release-candidate
npm run check:publication-gates
```

The last command is expected to fail while any human, browser, media, or remote gate is open.

Normal builds never increment the version. They update only the active automated-validation artifact fields; they do not write browser, performance, or accessibility hashes because only an actual exact-artifact run may bind those human-reviewed records. Pending manual hashes may remain null, while any recorded/approved hash must match the current runtime ZIP. Both build and verification fail if the runtime or stable-input version transaction is missing or stale. This keeps repeated unchanged builds deterministic while ensuring release-input changes cannot retain an old version or inherit old installed-browser evidence.

## Artifact contract

The builder constructs a fresh `dist/.current-staging/` directory, validates it, and promotes the whole directory to `dist/current/` with a rollback directory. Consumers and workflows use only `dist/current/`; historical files elsewhere under `dist/` cannot be mistaken for the current candidate. `current-release.json` binds the version, artifact names, byte sizes, and SHA-256 values, while `SHA256SUMS` covers that index and every payload.

The builder must create two distinct artifacts:

1. a loadable runtime ZIP containing only `scripts/release-files.mjs` entries, with `manifest.json` at archive root;
2. a source archive containing every path in the declared source closure—reviewed source, documentation, tests, scripts, lockfile, CI, assets, evidence, and third-party materials—excluding private/local material.

The runtime build also produces:

- `SHA256SUMS`;
- CycloneDX dependency inventory/SBOM;
- human-readable candidate release notes;
- machine-readable artifact inventory and unsigned provenance input;
- source/package byte-equivalence results.

Both archives use sorted paths and normalized timestamps. Verification reopens both archives and requires exact path, byte, and timestamp parity with the current source closures. Source roots, directories, and files may not be symbolic links.

An unsigned local provenance input is not an attestation. GitHub artifact attestation must be created by the reviewed manual release workflow for the exact artifact after remote controls are configured.

## Required local rejection checks

The build/verification path rejects or detects:

- version mismatch, invalid version/manifest description, missing resources, wrong icon dimensions, or wrong ZIP root;
- unknown runtime files or missing allowlisted files;
- remote script/resource origins, dynamic remote-code patterns, or inline handlers/scripts;
- absolute local paths, private keys, common secret formats, logs, profiles, caches, old archives, internal documents, prompts, or transcripts;
- files not byte-identical to the reviewed source after ZIP extraction;
- runtime dependency, lockfile-bound development-license, or third-party-notice inconsistencies;
- stale or extra files in `dist/current/`, a mismatched current-release index, stale manual evidence hashes, or symbolic links in either source closure.

## Git and tag integrity

Do not fabricate history from local ZIP timestamps. The clean repository may begin with the first reviewed public source and say that earlier private prototypes existed. Before release:

1. start from a clean, reviewed commit in the intended repository;
2. require the documented CI and CodeQL checks through branch protection;
3. use a protected/signed tag where available;
4. rebuild and verify from that exact commit in the manually approved release environment;
5. evaluate publication gates against those rebuilt bytes, then attest and checksum the generated files;
6. compare downloaded workflow artifacts with release assets;
7. record the tag, commit, workflow run, browsers, checksums, SBOM, attestation, and release notes in the evidence registry.

Do not execute release credentials on untrusted pull-request code and do not publish automatically after every merge.

## Browser validation before signing off

Load the final runtime ZIP (or its byte-equivalent unpacked tree) in new Chrome and Brave profiles. Run the matrix in [`testing.md`](./testing.md), retain synthetic machine-readable evidence, capture authentic media only from those profiles, and update compatibility claims to the exact versions tested.

## Verification by a recipient

A future release must document commands to download the runtime ZIP, `SHA256SUMS`, SBOM, and attestation; verify SHA-256; verify the GitHub attestation; inspect `manifest.json` at ZIP root; and compare packaged bytes to the tagged source allowlist. Those commands must use the final remote and artifact names and cannot be filled with invented URLs.

## Rollback and incident handling

If a scope, protected-data, redaction, permission, DNR, verification, or package-integrity defect is found:

1. stop publication/store rollout;
2. preserve the affected artifact hash and synthetic reproduction evidence privately;
3. mark the candidate/release affected without overstating impact;
4. add a regression test and update the threat model/safety case;
5. rebuild with a new version and checksum;
6. issue an accurate safety advisory through the approved confidential/public routes.

Private prototypes `1.9.4`–`1.9.7` must not be published as downloads because they contained the retired profile-wide `formData` path.
