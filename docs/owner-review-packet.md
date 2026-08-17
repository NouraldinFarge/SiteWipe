# SiteWipe owner review packet

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

Prepared and updated 2026-08-17. This packet records decisions that only the owner can make. The owner has now selected MIT, confirmed provenance/author identity, and authorized the first private staging commit and push. Remaining blank/false fields are intentional; do not edit them merely to satisfy a gate. Each later external action still needs action-time authorization even after its underlying decision is approved.

## Current decision summary

| Decision                              | Current evidence                                                                                                                                      | Current state                                                   | Consequence of approval                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product identity                      | Owner statement selects **SiteWipe**; two Chrome and two Firefox exact-name listings, an exact GitHub repository, and the registered `.com` are known | Approved identity; uniqueness/legal/store clearance not claimed | Continue using SiteWipe while knowingly accepting confusion/discoverability risk; does not approve publication or a trademark conclusion                            |
| Exact public version                  | Owner confirmed `1.11.1`; adding the license/release controls requires a mandatory patch bump                                                         | Superseded; renewed approval required                           | Approves only the named version for consideration as a public candidate; any later stable-input change requires a new version and renewed approval                  |
| Project license/source model          | Standard MIT `LICENSE`, decision record, SPDX package metadata, and exact license hash                                                                | Owner-approved MIT                                              | Grants the MIT permissions for first-party SiteWipe source; third-party components remain under their separately identified terms                                   |
| Copyright, authorship, and provenance | Exact owner statement, technical closure/dependency/notices/icon audit, and substantial AI-assistance disclosure                                      | Owner + technical approval recorded                             | Confirms authority to publish the declared first-party source closure without turning third-party work into first-party work or supplying a legal/trademark opinion |
| First local Git commit                | Unborn `main`, zero commits, confirmed author name and GitHub no-reply address                                                                        | Authorized                                                      | Allows one truthful initial candidate commit without fabricated history                                                                                             |
| Intended private remote               | `https://github.com/NouraldinFarge/SiteWipe`; maintainer `NouraldinFarge`                                                                             | Approved for private staging                                    | Allows creation of that private repository only; public visibility remains separate                                                                                 |
| Private upload/security setup         | First private push authorized; local CI/CodeQL definitions exist; remote execution/settings proof does not                                            | Initial private upload authorized; settings unverified          | Allows source upload to the named private remote; repository-setting changes and their results must still be explicitly verified and recorded                       |
| Public visibility                     | Publication gate is blocked                                                                                                                           | Not eligible/not approved                                       | Would expose source/history publicly; must not be combined with private-upload approval and cannot be requested while the gate is red                               |
| Release/tag/attestation               | No tag/release/remote attestation                                                                                                                     | Not eligible/not approved                                       | Creates immutable public distribution/provenance surfaces for exact reviewed bytes; requires separate authorization after public-repo approval                      |
| Store submission                      | Stable privacy URL/contact, installed evidence, media, exact disclosures, and owner approvals are absent                                              | Not eligible/not approved                                       | Sends artifact, user-data answers, permissions, privacy policy, and media to a browser-store reviewer; publication remains a separate store-controlled outcome      |
| Portfolio/résumé/LinkedIn/Indeed      | Local drafts only; SiteWipe is absent from approved public evidence                                                                                   | Not eligible/not approved                                       | Adds a private candidate to professional surfaces; allowed only after claims are backed, exact wording is approved, and publication status is accurate              |

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
2. named private remote and action-time permission to create and make the first private upload—complete; settings remain to be verified;
3. public repository visibility;
4. tag, GitHub Release, checksums/SBOM/attestation publication;
5. browser-store submission;
6. portfolio, résumé, LinkedIn, Indeed, GitHub profile/pins, posts, messages, or applications.

No stage implies the next one.
