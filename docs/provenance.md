# Ownership and provenance audit

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

Status: **owner provenance confirmation and MIT decision recorded; the active provenance and automated records govern current-candidate technical status**. Older completed technical records are historical only. This inventory is evidence, not legal advice. Permission for SiteWipe's first-party source is stated in the root `LICENSE`; identified third-party material remains under its own terms.

## Repository content classes

| Class                                      | Origin / handling                                                       | Current disposition                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Extension JS/HTML/CSS                      | Owner-created project plus substantial AI-assisted review/refactor      | Owner confirmed publication rights; continue treating every change as untrusted until review and tests                      |
| Root documentation and tests               | AI-assisted engineering work created for this audit                     | MIT-licensed as first-party work; disclose assistance and retain technical review controls                                  |
| Public Suffix List data/runtime derivative | Public Suffix List project, pinned commit, MPL-2.0                      | Source/license/metadata preserved; see notices                                                                              |
| PSL conformance fixture                    | Upstream PSL test corpus, CC0-1.0 header                                | Pinned local fixture and notice preserved                                                                                   |
| npm development tools                      | Registry packages locked in `package-lock.json`                         | Owner acknowledged the inventory; current audit, license, and development-SBOM status lives in the active dependency record |
| Runtime dependencies                       | None                                                                    | Verify from final package and SBOM                                                                                          |
| Baseline PNG icons                         | Supplied with private prototype; original editable source was not found | Replaced in runtime; immutable baseline hashes remain in private baseline evidence                                          |
| Current candidate icon                     | Original project-controlled geometric SVG plus generated PNGs           | Owner asset-rights confirmation remains recorded; current technical verification lives in the active provenance record      |
| Internal design plan DOCX                  | Private generic planning material outside repository                    | Explicitly excluded; do not publish or copy into provenance                                                                 |
| Historical ZIPs and obsolete source        | Private local evidence outside repository                               | Explicitly excluded; do not publish; retained locally without deletion                                                      |
| Prompts/chat/agent logs                    | Internal workflow material                                              | Must never be committed or published as provenance                                                                          |

## AI-assisted engineering disclosure

This project was developed through an AI-assisted engineering workflow. AI agents supported research, implementation, testing, and iteration. Product requirements, architecture, permission boundaries, validation criteria, safety decisions, provenance review, and release approval remain human-controlled. Agent output is treated as untrusted until reviewed and tested.

Do not claim that every line was manually authored. Do not assign copyright ownership to a person who has not reviewed and can substantiate it.

## Audit checklist

- [x] Owner confirms the origin and right to publish the declared first-party source closure.
- [x] Owner confirms that no employer, client, school, or confidential material is included.
- Review every current source and generated file; exact-candidate review status belongs in the active provenance record and pull-request review history.
- Revalidate the project-controlled editable SVG, generated PNG hashes, and zero-external-asset claim; the active provenance record is authoritative for the current technical result, while owner publication-rights confirmation remains recorded.
- [ ] Generated screenshots/demo use synthetic data and contain no identifiers.
- Revalidate PSL data, derivative notice, test fixture, exact hashes, and upstream license texts for each source closure; the active provenance record is authoritative for the current technical result.
- Revalidate each lockfile's complete development-package license inventory, metadata exception, and development SBOM; the active dependency record is authoritative for the current technical result. The owner acknowledgement remains recorded; it is not legal advice.
- [x] Owner confirms that no unrelated extension or competitor source was copied.
- Re-run the full declared source-closure private-path/secret/symlink/junction scan for each candidate; exact current status and counts belong only in the active provenance and automated evidence records.
- [x] Owner selects MIT and the exact root license bytes are recorded and machine-checked.
- [x] Owner provenance and first-party-rights decisions remain recorded; candidate-sensitive technical fields in the machine record are intentionally reset after stable changes.

The publication gate consumes `docs/evidence/provenance-audit.json`. Its owner-provenance fields remain recorded, and that active record is authoritative for the current technical status of every candidate-sensitive branch. A historical technical pass does not approve the current exact version, installed-browser claims, media, remote controls, public visibility, a release, a store submission, or professional-profile publication.

The machine-readable dependency inventory is retained at `docs/evidence/dependency-license-inventory.json`. Older completed lockfile bindings, audits, and development SBOMs are historical and cannot certify a later candidate after the root lockfile changes. The active inventory is authoritative for the current lockfile hash, exact transitive license counts, legacy metadata exception proof, disabled-lifecycle-script disclosure, vulnerability audit, and CycloneDX development SBOM. Metadata and owner acknowledgement remain evidence rather than a legal opinion; the final runtime artifact must still prove zero runtime dependencies separately.
