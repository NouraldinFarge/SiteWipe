# Deferred SiteWipe 1.11.78 follow-up work

Reviewed 2026-08-24. This register separates later engineering improvements from the gates that must still pass before any supported binary, default-branch merge, tag, GitHub Release, browser-store submission, promotional publication, or portfolio claim. Authorization for an action does not make its technical or independent-review evidence pass.

## Required before a supported binary or equivalent public-release claim

- Implement the installed-browser scenario executor. The canonical 24-scenario matrix, isolated fixture, evidence types, ownership plan, and bounded native-dialog policy exist, but there is not yet a runner that launches the exact packaged extension in clean Chrome and Brave profiles and executes all 48 browser/scenario cells.
- Complete and mechanically replay the full installed matrix. Every one of the 48 canonical Chrome/Brave cells must pass with assertion-specific raw evidence, protected downloaded-file canaries, exact artifact/browser/profile identity, and verified teardown. Missing, limited, failed, dummy, or self-authored summary evidence must remain blocking.
- Obtain independent human review where a protected environment or publication stage requires it. The current solo-reviewer environment configuration cannot truthfully satisfy independent review or self-review prevention by itself.
- Implement the authenticated remote collector/raw-body replayer, then refresh exact-head remote evidence after the final candidate commit exists. Required CI and CodeQL conclusions must bind to that immutable candidate head; the collector must retain ignored raw response bytes, recompute every digest, derive projections from those bytes, and bracket branch protection, private vulnerability reporting, protected-environment, privacy, and reviewer-eligibility observations with unchanged candidate/main refs.
- Refresh exact-version hosted privacy-policy parity, authentic media, accessibility, and performance evidence wherever the applicable publication stage requires them. Historical 1.11.67 observations cannot be rebound to 1.11.78.
- Preserve the distinction between an authorized public-source candidate and a supported binary. A source branch or pull request may be published when its source-specific gates pass even while installed-browser, media, reviewer, or store-release gates remain open.

## Recommended engineering improvements after the minimum candidate repair

- Add direct controller-level Options UI coverage so permission-state warnings, concurrent Options pages, setting locks, import/reset behavior, and every visible/internal setting are exercised through rendered interactions rather than source contracts alone.
- Define path-free semantic receipts for every installed-browser assertion and a decoded-content privacy validator before public replay is implemented. Full plans, raw/base64 records, screenshots, profile/download/helper paths, and capability tokens must remain outside Git; digest-only commitments must remain non-passing.
- Continue separating the service worker and cleanup preflight into smaller ownership, permission, query-planning, data-adapter, and reporting units with explicit transactional interfaces.
- Replace remaining source-text publication validators with structured syntax-tree or runtime-contract validators where mutation tests show textual containment is insufficient.
- Implement bounded, identity-checked retention cleanup for disposable profiles and raw evidence. The safe current policy retains owned runs and removes only exact verified locks; it does not yet enforce the declared 14-day/30-day age limits automatically.
- Add cross-host reproducibility evidence on a second supported build host. Two byte-identical builds on one validated host prove deterministic repetition there, not universal cross-platform reproducibility.
- Refresh development dependencies deliberately, preserving the exact lockfile, zero runtime dependencies, license inventory, ignored-lifecycle-script install, audit, and development SBOM contracts.
- Add a Windows installed-browser job or equivalent trusted Windows validation host alongside Ubuntu CI so native Chrome/Brave and UI Automation behavior can be repeated without relying on a maintainer workstation.
- Improve repository governance: require pull requests on `main`, retain exact required contexts, eliminate the protected-environment solo-reviewer deadlock, and keep administrator/force-push/deletion boundaries explicit.
- Correct or replace malformed historical CodeQL dismissal metadata and review every dismissed alert against current source. Historical comments must not be presented as current independent review.
- Move version-specific browser/media/performance records into immutable external attestations or an append-only evidence archive keyed to the tested source commit, artifact hash, harness hash, and result-set hash. The current tracked browser finalization contract now accepts exactly `docs/evidence/browser-validation.json` after the tested commit; future evidence types need their own equally narrow allowlisted-delta contract and must never be described as the exact commit that was tested.

## Explicitly not defects or completed claims

- Download deletion remains outside the automated synthetic matrix unless a scenario uses a clearly owned disposable file and the exact destructive scope is separately authorized. Ordinary downloaded files are never test inputs.
- Incognito/private access remains default-off and must not be enabled merely to increase coverage.
- The local unsigned provenance input is not a GitHub artifact attestation.
- A clean source commit, reproducible ZIP, passing deterministic tests, public repository, pull request, or owner authorization is not by itself installed-browser proof, independent review, store approval, or a supported-binary release.
