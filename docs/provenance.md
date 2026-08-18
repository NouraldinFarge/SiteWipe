# Ownership and provenance audit

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

Status: **technical review passed; owner provenance confirmation and MIT decision recorded**. This inventory is evidence, not legal advice. Permission for SiteWipe's first-party source is stated in the root `LICENSE`; identified third-party material remains under its own terms.

## Repository content classes

| Class                                      | Origin / handling                                                       | Current disposition                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Extension JS/HTML/CSS                      | Owner-created project plus substantial AI-assisted review/refactor      | Owner confirmed publication rights; continue treating every change as untrusted until review and tests  |
| Root documentation and tests               | AI-assisted engineering work created for this audit                     | MIT-licensed as first-party work; disclose assistance and retain technical review controls              |
| Public Suffix List data/runtime derivative | Public Suffix List project, pinned commit, MPL-2.0                      | Source/license/metadata preserved; see notices                                                          |
| PSL conformance fixture                    | Upstream PSL test corpus, CC0-1.0 header                                | Pinned local fixture and notice preserved                                                               |
| npm development tools                      | Registry packages locked in `package-lock.json`                         | Complete 406-package technical license inventory and SBOM generation pass; owner acknowledged inventory |
| Runtime dependencies                       | None                                                                    | Verify from final package and SBOM                                                                      |
| Baseline PNG icons                         | Supplied with private prototype; original editable source was not found | Replaced in runtime; immutable baseline hashes remain in private baseline evidence                      |
| Current candidate icon                     | Original project-controlled geometric SVG plus generated PNGs           | Editable source, no external assets, four render hashes, and owner asset-rights confirmation pass       |
| Internal design plan DOCX                  | Private generic planning material outside repository                    | Explicitly excluded; do not publish or copy into provenance                                             |
| Historical ZIPs and obsolete source        | Private local evidence outside repository                               | Explicitly excluded; do not publish; retained locally without deletion                                  |
| Prompts/chat/agent logs                    | Internal workflow material                                              | Must never be committed or published as provenance                                                      |

## AI-assisted engineering disclosure

This project was developed through an AI-assisted engineering workflow. AI agents supported research, implementation, testing, and iteration. Product requirements, architecture, permission boundaries, validation criteria, safety decisions, provenance review, and release approval remain human-controlled. Agent output is treated as untrusted until reviewed and tested.

Do not claim that every line was manually authored. Do not assign copyright ownership to a person who has not reviewed and can substantiate it.

## Audit checklist

- [x] Owner confirms the origin and right to publish the declared first-party source closure.
- [x] Owner confirms that no employer, client, school, or confidential material is included.
- [ ] Every current source and generated file receives human review.
- [x] The inherited PNG-only icon was replaced by a project-controlled editable SVG; source/output hashes, zero external assets, and owner publication-rights confirmation are verified.
- [ ] Generated screenshots/demo use synthetic data and contain no identifiers.
- [x] PSL data, derivative notice, test fixture, exact hashes, and upstream license texts are technically verified.
- [x] All 406 locked development packages are inventoried by declared license; the sole missing lockfile field is resolved from the installed package's MIT declaration and exact license-text hash. The owner acknowledged the inventory; it is not legal advice.
- [x] Owner confirms that no unrelated extension or competitor source was copied.
- [x] The full declared source closure passes private-path/secret scanning and rejects prompts, transcripts, profiles, reports, absolute private paths, archives, keys, logs, symbolic links, and directory junctions. Exact current counts belong in the active dated evidence record.
- [x] Owner selects MIT and the exact root license bytes are recorded and machine-checked.
- [x] Owner approves the machine-readable provenance record for the current source closure.

The publication gate consumes `docs/evidence/provenance-audit.json`. Its technical and owner-provenance fields pass. That does not approve an exact public version, installed-browser claims, media, remote controls, public visibility, a release, a store submission, or professional-profile publication.

The machine-readable dependency inventory is retained at `docs/evidence/dependency-license-inventory.json`. `scripts/check-dependency-licenses.mjs` binds it to the lockfile hash, exact transitive license counts, the one legacy metadata exception's installed MIT text, and the one package whose lifecycle script is disabled by `npm ci --ignore-scripts`. Metadata and owner acknowledgement remain evidence rather than a legal opinion. The final local build produces a zero-runtime-dependency SBOM; `npm run sbom` also generated a CycloneDX development SBOM successfully for human review, while the 406-entry lockfile inventory remains the authoritative technical package count.
