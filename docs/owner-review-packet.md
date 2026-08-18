# SiteWipe owner review packet

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

Prepared and updated 2026-08-17. This packet records decisions that only the owner can make. The owner selected MIT, confirmed provenance/author identity, authorized the initial commit/upload, and later authorized public source visibility. The signed-in owner view is public, but anonymous requests currently return `404`; source availability is therefore not recruiter-verifiable. Remaining blank/false safety, artifact, store, release, and promotion fields are intentional and must not be edited merely to satisfy a gate.

## Current decision summary

| Decision                              | Current evidence                                                                                                                                      | Current state                                                   | Consequence of approval                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product identity                      | Owner statement selects **SiteWipe**; two Chrome and two Firefox exact-name listings, an exact GitHub repository, and the registered `.com` are known | Approved identity; uniqueness/legal/store clearance not claimed | Continue using SiteWipe while knowingly accepting confusion/discoverability risk; does not approve publication or a trademark conclusion                            |
| Exact public version                  | Owner confirmed `1.11.1`; adding the license/release controls requires a mandatory patch bump                                                         | Superseded; renewed approval required                           | Approves only the named version for consideration as a public candidate; any later stable-input change requires a new version and renewed approval                  |
| Project license/source model          | Standard MIT `LICENSE`, decision record, SPDX package metadata, and exact license hash                                                                | Owner-approved MIT                                              | Grants the MIT permissions for first-party SiteWipe source; third-party components remain under their separately identified terms                                   |
| Copyright, authorship, and provenance | Exact owner statement, technical closure/dependency/notices/icon audit, and substantial AI-assistance disclosure                                      | Owner + technical approval recorded                             | Confirms authority to publish the declared first-party source closure without turning third-party work into first-party work or supplying a legal/trademark opinion |
| Initial Git history                   | `main` begins with a truthful candidate commit; local and signed-in owner-view main align at `29d0a6e`                                                | Complete for the published baseline                             | Does not imply that later draft commits, binary artifacts, or prototype history are released                                                                        |
| Repository destination                | `https://github.com/NouraldinFarge/SiteWipe`; maintainer `NouraldinFarge`                                                                             | Owner-approved public-source destination                        | Source visibility is distinct from binary/store release and professional-profile approval                                                                           |
| Repository/security setup             | Owner view: public; required CI/CodeQL contexts, protected `main`, PVR, dependency/secret/push controls; anonymous HTTP is `404`                      | Configured but externally unavailable                           | Requires restoration, exact-head checks, and a fresh settings audit before merge or recruiter use                                                                   |
| Public-source visibility              | Owner approved and owner view reports public; anonymous availability remains false                                                                    | Authorized; availability blocked                                | Does not authorize tags, binaries, stores, Pages, Packages, or professional-profile promotion                                                                       |
| Release/tag/attestation               | No tag/release/remote attestation                                                                                                                     | Not eligible/not approved                                       | Creates immutable public distribution/provenance surfaces for exact reviewed bytes; requires separate authorization after public-repo approval                      |
| Store submission                      | Stable privacy URL/contact, installed evidence, media, exact disclosures, and owner approvals are absent                                              | Not eligible/not approved                                       | Sends artifact, user-data answers, permissions, privacy policy, and media to a browser-store reviewer; publication remains a separate store-controlled outcome      |
| Portfolio/résumé/LinkedIn/Indeed      | SiteWipe lacks anonymous source availability, authentic exact-artifact media, installed-browser evidence, and final claim review                      | Not eligible/not approved                                       | Adds an unreleased candidate to professional surfaces; allowed only after claims are independently inspectable, backed, and explicitly approved                     |

## Safety decision presented to the owner

The former complete-review bypass was removed. The current source requires every Standard and Expert run to:

1. perform read-only preflight;
2. show the complete target/scope/context/category/impact/permission/shield/retention/file/limitation/verification review;
3. collect every applicable acknowledgement, including typed target confirmation for downloaded-file deletion;
4. receive an explicit final SiteWipe activation;
5. validate and consume a short-lived, single-use, context-bound approval before recovery or cleanup mutation.

This closes the consent design defect in source. It does not prove installed behavior. Exact-artifact Chrome/Brave, accessibility, interruption, retention, and performance evidence remains required.

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

## Approval sequence

Approvals must remain separate:

1. owner decisions: license/source model, provenance, author identity, and permission to create the first local commit—complete; exact `1.11.1` approval is superseded by the required patch bump;
2. named repository, initial upload, and public-source configuration—complete in owner view; anonymous availability and exact-head checks remain open;
3. public repository visibility;
4. tag, GitHub Release, checksums/SBOM/attestation publication;
5. browser-store submission;
6. portfolio, résumé, LinkedIn, Indeed, GitHub profile/pins, posts, messages, or applications.

No stage implies the next one.
