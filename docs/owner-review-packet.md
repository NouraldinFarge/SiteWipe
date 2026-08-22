# SiteWipe owner review packet

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

Prepared 2026-08-17; safety, direct-cleanup, public-version, and repository-availability decisions updated 2026-08-20; exact 1.11.46 source-candidate authorization and candidate-truth review updated 2026-08-21. This packet records decisions that only the owner can make. The owner selected MIT, confirmed provenance/author identity, authorized the initial commit/upload and public source visibility, explicitly approved implementation of the default-off direct-cleanup design recorded in `docs/decisions/direct-cleanup-owner-decision.json`, and explicitly authorized preparing and uploading the tested 1.11.46 source as a GitHub candidate branch/PR. The 1.11.46 instruction limits interactive browser validation to the ChatGPT in-app Browser and prohibits Computer Use and Chrome; it therefore cannot approve or manufacture installed Chrome/Brave evidence. The repository is anonymously reachable; the current candidate is not yet on its default branch. Merge, tag, GitHub Release, artifact, installed-evidence, store, and promotion fields remain separate and must not be edited merely to satisfy a gate.

## Current decision summary

| Decision                              | Current evidence                                                                                                                                                              | Current state                                                   | Consequence of approval                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product identity                      | Owner statement selects **SiteWipe**; two Chrome and two Firefox exact-name listings, an exact GitHub repository, and the registered `.com` are known                         | Approved identity; uniqueness/legal/store clearance not claimed | Continue using SiteWipe while knowingly accepting confusion/discoverability risk; does not approve publication or a trademark conclusion                                    |
| Exact public version                  | Owner selected the 1.11.17 codebase over the discarded 1.11.29 draft, later approved 1.11.42, and on 2026-08-21 explicitly selected the expiry/fixture corrections as 1.11.46 | 1.11.46 source candidate approved; merge/release not approved   | Approves only the exact version recorded in `product-identity.json`; later stable-input changes require another forward-only version and an explicit exact-version decision |
| Project license/source model          | Standard MIT `LICENSE`, decision record, SPDX package metadata, and exact license hash                                                                                        | Owner-approved MIT                                              | Grants the MIT permissions for first-party SiteWipe source; third-party components remain under their separately identified terms                                           |
| Copyright, authorship, and provenance | Exact owner statement and substantial AI-assistance disclosure; current technical status lives in `provenance-audit.json`                                                     | Owner decision retained; see active technical evidence          | Confirms authority to publish the declared first-party source closure without turning third-party work into first-party work or supplying a legal/trademark opinion         |
| Initial Git history                   | `main` begins with a truthful candidate commit; local and signed-in owner-view main align at `29d0a6e`                                                                        | Complete for the published baseline                             | Does not imply that later draft commits, binary artifacts, or prototype history are released                                                                                |
| Repository destination                | `https://github.com/NouraldinFarge/SiteWipe`; maintainer `NouraldinFarge`                                                                                                     | Owner-approved public-source destination                        | Source visibility is distinct from binary/store release and professional-profile approval                                                                                   |
| Repository/security setup             | Repository is publicly reachable; prior audit observed required CI/CodeQL contexts, protected `main`, PVR, dependency/security, secret, and push controls                     | Publicly available; exact-head/settings re-audit pending        | Requires fresh exact-head checks and a settings audit before merge or recruiter claims                                                                                      |
| Public-source visibility              | Owner approved; anonymous repository access independently succeeds                                                                                                            | Authorized and available                                        | Does not authorize tags, binaries, stores, Pages, Packages, or professional-profile promotion                                                                               |
| Optional direct cleanup               | Owner explicitly requested a Settings option, Standard and Expert support, one SiteWipe popup action, and incognito operation                                                 | Design approved; installed evidence pending                     | Allows implementation of default-off `skipCleanupReview`/`settings_direct`; does not approve an exact artifact or waive browser/native/incognito evidence                   |
| Release/tag/attestation               | No tag/release/remote attestation                                                                                                                                             | Not eligible/not approved                                       | Creates immutable public distribution/provenance surfaces for exact reviewed bytes; requires separate authorization after public-repo approval                              |
| Store submission                      | Complete reviewer-approved browser/accessibility/performance/media evidence, exact disclosures, and destination approval remain incomplete                                    | Not eligible/not approved                                       | Sends artifact, user-data answers, permissions, privacy policy, and media to a browser-store reviewer; publication remains a separate store-controlled outcome              |
| Portfolio/résumé/LinkedIn/Indeed      | SiteWipe has public source but still lacks approved authentic exact-artifact media, a complete reviewed browser matrix, and final claim review                                | Not eligible/not approved                                       | Adds an unreleased candidate to professional surfaces; allowed only after claims are independently inspectable, backed, and explicitly approved                             |

## Direct-cleanup safety decision

The retired implementation remains historical and unapproved. On 2026-08-20, the owner explicitly directed the new **Skip detailed cleanup review completely** (`skipCleanupReview`) opt-in for both Standard and Expert modes. The current contract requires every run to:

1. perform a fresh read-only preflight;
2. derive either default `detailed_review` or opt-in `settings_direct` from strict current stored settings;
3. bind the active mode, normalized target, associated scope, source/private context, incognito-access state, complete impact, exact/relevant broader access inventory, permission lease, and downloaded-file IDs into a short-lived, single-use record;
4. in detailed mode, show the complete review and collect every applicable acknowledgement, including the typed file phrase;
5. in direct mode, use one **Clean now** SiteWipe action after a separately confirmed Settings opt-in, skip the detailed screen and typed phrase, and truthfully claim no per-run acknowledgements;
6. re-read current settings and private-access state, reconstruct the complete bound snapshot, exact-match the prepared mode, and consume the token before recovery or cleanup mutation.

Chrome/Brave may still add a native permission confirmation after the one SiteWipe action. Private-source direct cleanup requires browser-controlled **Allow in incognito** plus pre-existing exact target access; SiteWipe cannot enable or prompt either from that private path. Expert file IDs remain preflight-bound and immediately live-revalidated. Reports must label `settings_direct`, `scopeReviewApproved: false`, and saved direct authorization without implying a detailed review or typed phrase.

This is an owner design approval, not exact-version, artifact, binary, store, or publication approval. It does not prove installed behavior. ChatGPT in-app Browser checks are synthetic UI evidence only. Exact-artifact installed Chrome/Brave detailed/direct flows, native prompt, incognito, accessibility, interruption, retention, file-system, and performance evidence remains required.

## Recorded license/source-model decision

The owner selected MIT. The root `LICENSE`, `docs/decisions/license.json`, root package, lockfile root, and extension-source package all identify MIT, and an automated check binds the exact license bytes. The packages remain `private: true` to prevent accidental npm publication. The bundled PSL remains MPL-2.0 and its conformance corpus CC0-1.0 under the retained notices; MIT does not replace those third-party terms.

## Provenance assertions confirmed by the owner

Before the first commit/upload, the owner confirmed the recorded statement covering these assertions:

- the candidate source may be published without exposing employer, client, school, confidential, personal, or licensed-only material;
- the outer working container (the parent of the repository root) and its `_work`, caches, archives, agent material, documents, and historical packages are excluded;
- the icon/editable SVG may be published under the chosen project terms;
- third-party notices and all locked development licenses are acceptable for the chosen distribution model;
- substantial AI-agent assistance is accurately disclosed and does not conflict with any applicable obligations;
- the Git author name/email chosen for the first commit are the owner's intended public/private identity;
- no claim of trademark clearance, uniqueness, public release history, TypeScript runtime implementation, measured speed, full erasure, or Chrome/Brave compatibility is made without its required evidence.

## Risk acceptance still required

Even after all tests pass, publication would retain these material limits:

- browser APIs are partial/asynchronous and can finish after a timeout;
- cookie cleanup for exact local origins is host-scoped and does not distinguish ports;
- websites, Sync, servers, networks, operating systems, enterprise tools, and unexposed browser stores can retain or recreate data;
- permission removal or DNR diagnosis can fail and remain pending for manual/retry recovery;
- redaction reduces accidental disclosure but is not anonymization;
- exact-name marketplace collisions create confusion/discoverability risk;
- downloaded-file removal is intentionally irreversible when enabled and approved in Expert mode.
- the direct setting intentionally removes per-run scope visibility, acknowledgements, and the Expert file phrase; its fresh hidden preflight and live guards reduce scope error but cannot make destructive effects recoverable.

## Approval sequence

Approvals must remain separate:

1. owner decisions: license/source model, provenance, author identity, permission to create the first local commit, implementation of the ADR 0011 default-off direct-cleanup design, and exact 1.11.46 source-candidate selection—complete;
2. named repository, initial upload, public-source configuration, anonymous availability, and authorization to upload the tested 1.11.46 candidate branch/PR—complete; exact-head checks, merge, and the final remote-settings audit remain open;
3. merge of the reviewed candidate into the public default branch;
4. tag, GitHub Release, checksums/SBOM/attestation publication;
5. browser-store submission;
6. portfolio, résumé, LinkedIn, Indeed, GitHub profile/pins, posts, messages, or applications.

No stage implies the next one.
