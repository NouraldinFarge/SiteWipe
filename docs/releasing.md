# Release process

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

There is no approved supported-binary release process execution yet. These steps produce a reviewable unreleased candidate; public source availability does not authorize tagging, creating a GitHub Release, portfolio promotion, or browser-store submission.

## Human prerequisites

Before the first supported binary release, the owner must approve and record:

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

The command accepts `minor`, `major`, or an explicit forward-only `x.y.z` in place of `patch`. Before rebinding the dependency-inventory hash, it requires that inventory to match the exact pre-bump lockfile; a dependency change therefore needs a fresh reviewed inventory rather than an automatic hash rewrite. The transaction stages every version/document/evidence change, writes a recovery journal, promotes the complete set, and records separate reviewed fingerprints for the runtime and every stable release input. The stable-input contract covers source, scripts, CI, tests, documentation, configuration, assets, lockfile, and third-party material. Mutable post-build evidence and owner-approval JSON are explicitly excluded to prevent circular invalidation. An interrupted uncommitted transaction rolls back on the next run; a committed transaction finishes cleanup. The bump resets browser, performance, installed-accessibility, media, automated-check, dependency-audit, fixture, artifact, Git/head, and technical-provenance results to pending while retaining the separate owner provenance statement. Do not update version copies or evidence bindings individually.

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

Normal builds never increment the version. They update only the active automated-validation artifact fields; they do not write browser, performance, or accessibility hashes because only an actual exact-artifact run may bind those human-reviewed records. Pending manual hashes may remain null, while any recorded/approved hash must match the current runtime ZIP. Build and verification fail if the runtime or stable-input version transaction is missing or stale. The publication gate independently reruns the same version contract and exact checksum/path/byte/timestamp/source-closure verification instead of trusting command order or a recorded `passed` boolean. This makes unchanged builds reproducible within the recorded environment while ensuring release-input changes cannot retain an old version or inherit old validation evidence.

The publication gate also enforces ADR 0011's source contract without claiming installed behavior: the owner decision must remain truthful and installed evidence pending; `skipCleanupReview` must default off; enabling it must require explicit confirmation; hidden preflight/permission-lease preparation must complete before **Clean now**; `settings_direct` must remain single-use, current-settings-bound, file-ID-bound, and truthfully reported; and the service worker must expose no raw cleanup route that avoids prepared-token consumption. Functional and installed tests remain required because static gate markers are defense in depth, not browser evidence.

## Artifact contract

The builder constructs a fresh `dist/.current-staging/` directory, validates it, and promotes the whole directory to `dist/current/` with a rollback directory. Consumers and workflows use only `dist/current/`; historical files elsewhere under `dist/` cannot be mistaken for the current candidate. `current-release.json` binds the version, artifact names, byte sizes, and SHA-256 values, while `SHA256SUMS` covers that index and every payload.

The builder must create two distinct artifacts:

1. a compressed loadable runtime ZIP containing only `scripts/release-files.mjs` entries, with `manifest.json` at archive root;
2. an uncompressed, stored-entry source ZIP containing every path in the declared source closure—reviewed source, documentation, tests, scripts, lockfile, CI, assets, evidence, and third-party materials—excluding private/local material.

The runtime build also produces:

- `SHA256SUMS`;
- CycloneDX dependency inventory/SBOM;
- human-readable candidate release notes;
- machine-readable artifact inventory and unsigned provenance input;
- source/package byte-equivalence results.

Both archives use sorted paths, fixed file modes, and normalized timestamps. Verification reopens both archives and requires exact path, content-byte, and timestamp parity with the current source closures. It additionally requires every source-ZIP entry to be stored rather than compressed, avoiding platform-specific DEFLATE output and making the source archive's bytes reproducible across supported hosts when the same locked tools and source bytes are used. The runtime ZIP remains compressed: its extracted content contract is deterministic, but archive-level SHA-256 equality across operating systems must not be claimed until a two-host comparison records it. Same-host consecutive-build equality is useful evidence but is not a substitute for that cross-platform check. Source roots, directories, and files may not be symbolic links.

An unsigned local provenance input is not an attestation. GitHub artifact attestation must be created by the reviewed manual release workflow for the exact artifact after the `unreleased-candidate` environment is created with required reviewers and remote controls are independently verified.

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

ChatGPT in-app Browser testing is a separate synthetic web-UI layer. It may inspect an HTTP-served harness for layout, accessible structure, keyboard flow, responsive behavior, and review wording, but it does not load the extension artifact or exercise native permission prompts, private windows, MV3 service-worker lifecycle, or privileged Chrome APIs. Never use in-app Browser output to populate installed Chrome/Brave evidence, exact-artifact compatibility, performance, or store-media approval fields.

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
