# Release process

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

SW-084 through SW-089 strengthened the exact-1.11.93 release procedure. Finalized records are derived from the exact frozen disk replay; all tracked gate inputs and media bytes come from one verified commit; the runtime digest is verifier-owned; `dist/current` is captured and replayed as one exact physical snapshot; optional automated finalization entries are an exact absent-or-pointer-plus-active-target pair; the committed finalization manifest is canonical and digest-bound to the final replay; and automated evidence pointer, filename, and record versions equal the package version. Media parsing is intentionally not a playback claim: visible authenticity and successful playback remain a human reviewer prerequisite. Focused non-media integrity tests passed 63/63 and media-contract tests passed 118/118.

Exact 1.11.93 completed its guarded transaction with runtime fingerprint `7884F251F8FD56D7EC4A8676DCF0FC4BC9790BD46FF56837A1013EF8A123334B` and 310-input stable-release fingerprint `0FBF99145E648F862F72AA834DC075B2ED12B34776B4EBEC7BA5F2D7CBD97205`, then its first complete check stopped at `check:secrets` after all checks through remote-code passed, including syntax 217. No later stage ran. SW-090 stages only a forward-1.11.94 test-source correction that constructs the same validator-rejected synthetic Windows path and private file URL from non-private fragments. Semantic-validator 9/9, the secret scan across 413 source-archive files, Prettier, and ESLint passed; complete 1.11.94 validation and all later stages remain unrun.

Exact 1.11.94 subsequently completed its guarded transaction with runtime fingerprint `0EE478F2485E8615B7C07B1E6310D0383A59E945E021071F15A404D9341C2A7A` and 310-input stable-release fingerprint `B27F39A1752CC032F5B34B0CAACAF1E6570322E655623E9D6170D313E6417BAE`. Its first complete check passed every source safeguard through the legacy self-test. The unit suite completed 1,405 tests with 1,401 passed, one failed, and three platform skips in `540992.2203ms`; the sole failure was the exact-current owner-amended Direct Cleanup contract because mutable `reviewedVersion` remained 1.11.93. SW-091 stages the minimum forward 1.11.95 repair by synchronizing the reviewed, product, and remote candidate bindings and branch under unchanged authorization and invariants. Property testing, coverage, dependency reinstall/audit, artifacts, browsers, commit, push, remote checks, and publication did not run for 1.11.94. At the time the 1.11.95 stable inputs were sealed, complete 1.11.95 validation had not yet run, so the release process cannot advance and no supported-binary claim exists.

There is no approved supported-binary release process execution yet. These steps produce a reviewable unreleased candidate; public source availability does not authorize tagging, creating a GitHub Release, portfolio promotion, or browser-store submission.

The frozen 2026-08-22 record authorized the exact 1.11.56 source candidate and its pull request, and the 2026-08-23 record authorized the historical 1.11.67 candidate. The owner's 2026-08-24 instruction authorized the exact 1.11.78 audit, repair, build, and browser-validation work; the separate 2026-08-25 instruction authorizes GitHub and public-release actions only when their applicable gates genuinely pass. Historical version-qualified evidence keeps its original result and cannot be rebound to changed bytes. Exact 1.11.89 passed its complete local check, required coverage, strict packaging, repeated reproducibility, and exact-head CI and CodeQL at draft PR #12 head `6965c324f1bdec57361fc9664976f7022e86df03`. It remains unmerged and unreleased, and those source results do not supply installed-browser, accessibility, performance, media, hosted-policy, independent-review, final-authority, store, promotion, or supported-binary evidence. Exact local 1.11.90 failed before complete validation after canonical formatting changed its sealed stable-input bytes, and exact local 1.11.91 was superseded before complete validation under SW-080. Exact local 1.11.92 completed its version transaction with runtime fingerprint `8084015525025E824CE600D25553A28493BD5D7743B29103F007CCCD3A0F443F` and 305-input stable-release fingerprint `067AD9F681D349B810D7B0E2CA9BB68E5690322160ACD8F7DA347FF328598A31`; its first `npm run check` attempt passed formatting, version, the 212-file syntax scan, and types before stopping at two installed-runner `no-unsafe-finally` lint errors. No later test, coverage, build, browser, commit, push, or publication stage ran. The forward-only policy staged 1.11.93 with the SW-080/SW-081 lifecycle, bootstrap, closure, transaction, and immutable-finalization controls unchanged. SW-082 replaces the two throws from central cleanup `finally` with explicit `cleanupFailure` propagation. Separate SW-083 resolves the exact current dated validation record once, binds its normalized path and exact bytes as a read-only planning input captured and replayed under the lock, does not re-resolve the active pointer, and excludes mutable evidence from stable fingerprints. Its regression proves that post-capture record mutation refuses before version, pointer, or successor changes and that recovery leaves the record untouched. Focused validation passed the transaction suite at 34 total/33 passed/1 platform skip, the validation-evidence transition at 1/1, the installed-runner suite at 18/18, the then-current 1.11.93 syntax scan, types, lint, formatting, documentation, and diff checks; its later guarded transaction failed at `check:secrets` as recorded above. Missing, ambiguous, incompletely closed, or unimplemented semantics remain non-passing and automation cannot set reviewer approval. Current exact-source status belongs only to `docs/evidence/automated-validation-current.json`; current synthetic or installed-browser status belongs only to the active browser-evidence pointer. This stable document does not claim that 1.11.93 passed, was built, was pushed, or was published. The branch/PR stage requires synchronized source and documentation, a deliberate forward version transaction, complete local automated validation, reproducible source/runtime artifacts, and truthful source-candidate evidence; exact-head checks necessarily run after push. Full installed Chrome/Brave, accessibility, performance, media, hosted-policy, independent-review, and destination evidence remain separate merge/binary-publication gates. Authorization does not waive those gates, permit a protection bypass, or establish a supported binary.

Exact 1.11.95 passed its complete local check at 1,402 of 1,405 with zero failures and three explicit platform skips, property testing at 11/11, required coverage above every floor, a clean locked install and zero-vulnerability audit, and 48/48 accessibility source contracts. It remained uncommitted and unbuilt after the post-validation truth audit found non-temporal stable-stage wording, missing clean evidence-commit boundaries and repeated-reproducibility instructions, and a false description of build scripts as tracked-evidence writers. SW-092 stages those stable process corrections and necessary exact-candidate bindings in 1.11.96 without changing extension runtime behavior. At the 1.11.96 stable-input seal boundary no 1.11.96 validation exists; current status belongs only to active evidence.

Exact 1.11.96 then passed its complete local command: every source safeguard passed, the unit suite completed 1,405 tests with 1,402 passed, zero failed, and three explicit platform-inapplicable skips, and property testing passed 11/11. Coverage and all later stages did not run because the post-check audit found SW-093 before the long coverage run. The 1.11.97 successor corrects only the sentence that mislocated exact 1.11.95 historical results in active evidence, makes affected issue-register status cells version-neutral, and advances necessary exact-candidate bindings. At the 1.11.97 stable-input seal boundary no 1.11.97 result exists; current status belongs only to the dated automated record selected by the active pointer.

Exact 1.11.97 subsequently passed every safeguard in its complete local command, including 1,402 of 1,405 unit tests with zero failures and three explicit platform-inapplicable skips in `486086.3038ms` and 11/11 property tests in `254.7893ms`. Its coverage command was intentionally interrupted and has no valid result because SW-094 found inconsistent dependency commands and evidence enforcement, a false separate-CI-property-step claim, inadequate workflow timeouts, and a remote collector whose request header did not match its sealed API-version claim. The 1.11.98 successor makes only the exact dependency protocol, evidence reset/gate, CI sequencing, remote-capture, documentation, and necessary exact-candidate-binding corrections. The protected workflow consumes independently supplied expected binding and read-only credentials and captures fresh exact-head configuration, but it cannot attest reviewer availability or actual independent review. Clean reinstall/audit and every later release stage remained unrun for 1.11.97; at the 1.11.98 stable-input seal boundary no 1.11.98 result exists.

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

Use exact Node.js 24.18.1 with its bundled npm 11.16.0 for every candidate-evidence command. The broader package engine range is a development compatibility floor and does not replace this byte-parity requirement.

For every runtime change, first add an `Unreleased` changelog entry and perform one deliberate version transaction from the clean repository root:

```powershell
npm run version:bump -- patch
```

The command accepts `minor`, `major`, or an explicit forward-only `x.y.z` in place of `patch`. Before rebinding the dependency-inventory hash, it requires that inventory to match the exact pre-bump lockfile; a dependency change therefore needs a fresh reviewed inventory rather than an automatic hash rewrite. The transaction stages every version/document/evidence change, writes create-only canonical lock/journal/commit-marker/terminal records under the independently re-proved exact per-worktree Git directory, promotes the complete set, and records separate reviewed fingerprints for the runtime and every stable release input. The stable-input contract covers source, scripts, CI, tests, documentation, configuration, assets, lockfile, and third-party material. Mutable post-build evidence and owner-approval JSON are explicitly excluded to prevent circular invalidation. Any retained lock, journal, marker, or terminal state makes normal version-bump startup refuse; normal startup never auto-recovers or breaks a retained lock. Explicit recovery is a separate reviewed operation requiring the original exact sorted target/operation allowlist and a complete preflight of every target, temporary, backup, and control identity/topology before mutation. This is a bounded userspace recovery protocol, not an atomic multi-file filesystem commit. The bump resets browser, performance, installed-accessibility, media, automated-check, dependency-audit, fixture, artifact, Git/head, and technical-provenance results to pending while retaining the separate owner provenance statement. Do not update version copies or evidence bindings individually.

Then validate the source and locked development graph:

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run test:coverage
npm audit --audit-level=low --json
```

Record those exact results in the active automated-validation evidence, validate the evidence, commit the complete source/evidence tree, and require a clean worktree. Run one calibration build to obtain the exact runtime ZIP SHA-256 and byte count; record only those observed values and commit that evidence-only binding. From that new clean commit, run the commit-bound build, verification, and repeated reproducibility sequence:

```powershell
npm run build:release-candidate
npm run verify:release-candidate
npm run verify:reproducible-release-candidate
npm run check:publication-gates
```

After recording the successful artifact/reproducibility fields in a final evidence-only commit, rerun `npm run verify:reproducible-release-candidate` from that exact clean head because the source archive and embedded source-commit identity changed. The publication command is expected to fail while any human, browser, media, or remote gate is open.

Normal builds never increment the version and never write tracked evidence. After a successful build or verification, the operator must explicitly record only the exact observed artifact fields in the active automated-validation record, validate that evidence, and commit the evidence-only change before the next commit-bound artifact step. Browser, performance, accessibility, media, and reviewer fields may be bound only by their own actual exact-artifact procedures. Pending manual hashes may remain null, while any recorded or approved hash must match the current runtime ZIP. Build and verification fail if the runtime or stable-input version transaction is missing or stale. The reproducibility command performs two complete build-and-verification passes and compares every output byte for byte. The publication gate independently reruns the same version contract and exact checksum/path/byte/timestamp/source-closure verification instead of trusting command order or a recorded `passed` boolean. This makes unchanged builds reproducible within the recorded environment while ensuring release-input changes cannot retain an old version or inherit old validation evidence.

The publication gate also enforces ADRs 0011 and 0013 as source contracts without claiming installed behavior: the verbatim 1.11.56 interaction statements remain unchanged, while the later release-unblock instruction authorizes the exact final forward source-candidate branch and pull request selected after genuine installed blockers; installed evidence must remain pending until actually recorded; `skipCleanupReview` must default off and require explicit confirmation; an older saved direct opt-in must reset to off before the 1.11.63 selected-site/exact-origin disclosure marker is recorded; hidden preflight/permission-lease preparation must complete before **Clean now**; `settings_direct` must remain single-use, current-settings-bound, file-ID-bound, and truthfully reported; pregranted access must remain one SiteWipe activation; missing access must use activation-one durable arming with no popup permission call, followed by activation two only in the exact worker-created normal-window handoff tab; its static URL/history/storage must contain no raw authority; optional sender `documentId` must not be required or substitute for the unique worker-resolved `TAB` `contextId`; direct-open/reload/navigation/replacement/replay and old schema-2 popup records must fail closed; independent exact event and handoff-outcome proofs plus permission provenance must remain required; review expiry must revoke cleanup authority without discarding an invoked prompt tombstone/lease during ordinary in-session maintenance; the selected-site partitioned-storage effect and exact-origin closed-page limitation must stay disclosed; the final browser-data mutation boundary must reject exact-origin non-cookie storage/cache while retaining only the separately disclosed cookie-only host-scoped exception; and the service worker must expose no raw cleanup route that avoids prepared-token consumption. Functional and adversarial source tests remain required for the source candidate. Installed tests remain required for later merge and binary-publication claims because static gate markers are defense in depth, not browser evidence.

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

That protected environment must provide two independently administered, environment-level-only inputs before the workflow can run: the `SITEWIPE_GITHUB_READ_TOKEN` environment secret and the `SITEWIPE_REMOTE_PUBLICATION_EXPECTED_BINDING_JSON` environment variable. Do not create same-named repository- or organization-level fallbacks. The token must be an expiring, repository-restricted fine-grained personal access token whose principal has the underlying write, maintain, or administration access required to read collaborator eligibility and whose repository permissions are Administration read, Actions read, Checks read, Code scanning alerts read, Contents read, Environments read, and the automatically included Metadata read. This credential is not reviewer evidence. The workflow's ordinary `GITHUB_TOKEN` is insufficient because it cannot receive repository `Administration: read` or the required environment-metadata access. A narrowly installed GitHub App is the preferred later replacement.

The expected-binding variable is a separately prepared canonical one-line JSON expectation for the exact candidate/main heads, required-check app identities, immutable hosted-policy bytes, candidate actor, and environment; it must not be generated from the collector's own API responses. Only after locked install, complete checks, coverage, audit, and reproducible build verification pass does `npm run remote:stage-publication-inputs` use bounded, redirect-denying, GET-only GitHub API requests to verify the exact variable value and the same-named secret metadata under the literal `unreleased-candidate` environment. It binds those checks to `github.repository` and `github.repository_id`, uses the same sealed GitHub REST API version as the collector, and only then writes the canonical expectation create-only outside the repository. A missing protected input, same-named repository/organization fallback, mismatched value, wrong scope, redirect, malformed response, or credential reflection fails before collection.

The workflow then runs `npm run remote:collect-publication-evidence` into one ignored run-specific directory, uploads `capture.json`, `raw-responses.json`, and the independent expectation as a separate retained Actions artifact before publication evaluation, and passes both exact paths to `npm run check:publication-gates`. Missing, stale, malformed, self-derived, under-authorized, or unretained input fails closed. The API capture proves configuration only: a genuinely distinct eligible reviewer and actual independent exact-candidate review remain separate human gates and cannot be supplied by the workflow or its token.

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

After a genuine installed run, select the exact artifact, source, commit, and external owned-run identity independently before finalization. Inventory only the exact allowlisted evidence delta, then create the fixed canonical finalization manifest once through its unique synchronized sibling and no-overwrite publication path. The exact canonical on-disk manifest bytes must parse to an object identical to the supplied manifest; two complete file inventory passes and final directory/manifest identity replay must succeed. Any existing canonical manifest is immutable and is never overwritten or replaced; a later finalization requires the documented external archive or version-qualified successor lifecycle. The canonical manifest is currently absent and must remain absent until genuine exact-artifact evidence is ready for this sequence.

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
