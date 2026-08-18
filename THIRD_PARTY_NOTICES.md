# Third-Party Notices

This repository contains a public-source unreleased prerelease. The owner selected MIT for first-party SiteWipe source; third-party material remains governed by the separate terms recorded here and is not relicensed as first-party work.

## Public Suffix List

- Component: Public Suffix List data
- Upstream: https://publicsuffix.org/list/public_suffix_list.dat
- Repository: https://github.com/publicsuffix/list
- Snapshot: `2026-08-14_20-15-49_UTC`
- Commit: `a77cfe0674a4b05c6e2448c01f3cb2c965a1b6d8`
- SHA-256: `155B43D46932E933F622365225E7861288C36A45380B1F7D00B3D09748926226`
- License: Mozilla Public License 2.0 (`MPL-2.0`)
- Purpose: Fail-closed registrable-domain calculation, including ICANN and PRIVATE rules, wildcard rules, exception rules, and internationalized domain names
- Modifications: The pinned UTF-8 rule data is deterministically converted to lower-case ASCII/punycode arrays for local runtime use. No rules are intentionally added or removed.
- Generated runtime file: `src/shared/public-suffix-data.js`
- Preserved upstream source: `third_party/public-suffix-list/public_suffix_list.dat`
- License text: `third_party/public-suffix-list/LICENSE`
- Update tool: `scripts/update-public-suffix-data.mjs`
- Machine-readable metadata: `third_party/public-suffix-list/metadata.json`

The generated runtime data retains the MPL-2.0 source-file notice and identifies the exact upstream snapshot and commit.

## Public Suffix List conformance corpus

- Component: `tests/test_psl.txt`
- Upstream: https://github.com/publicsuffix/list/blob/a77cfe0674a4b05c6e2448c01f3cb2c965a1b6d8/tests/test_psl.txt
- SHA-256: `8F50AD958916D6A8F79FBA2363501475571ACCE752757F9126FE9D2F17DD920D`
- License: CC0 1.0 Universal (`CC0-1.0`), as declared in the file header
- Purpose: Conformance tests for registrable-domain behavior
- Local copy: `tests/fixtures/public-suffix-list/test_psl.txt`

No PSL data is downloaded by the browser extension at runtime. Network access is used only by the developer-controlled update script, and generated changes must pass review and the full domain safety suite before release.
