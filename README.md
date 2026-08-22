# SiteWipe

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

`SiteWipe` is the owner-approved custom product identity for a local-first Chrome/Brave Manifest V3 extension that coordinates guarded, target-scoped cleanup across browser APIs. The exact name is already used by unrelated browser extensions, so this selection is not represented as unique or legally cleared. It is not a promise to erase every trace. The first-party source is MIT-licensed and intended for public review, while the current candidate version `1.11.46` remains an unreleased prerelease with no supported binary or browser-store listing.

The interesting engineering problem is destructive scope control: a cleanup request must remain inside an authorized registrable site or exact local origin while Chrome exposes cookies, tabs, origin storage, history, downloads, scripting, and network rules through different APIs and lifecycle semantics.

## What is implemented

- A version-pinned, locally bundled Public Suffix List resolver with ICANN and PRIVATE rules, wildcards, exceptions, Unicode/IDN conversion, and fail-closed behavior.
- A deterministic, read-only scope-and-impact preflight before every run. Detailed review is the default in Standard and Expert modes. A separately confirmed, default-off **Skip detailed cleanup review completely** setting enables one-action `settings_direct` cleanup in either mode while retaining a short-lived, single-use approval bound to the current target, settings, associated/private scope, host access, impact, and downloaded-file IDs. Chrome/Brave may still show its own exact-target access prompt after the SiteWipe action.
- Standard and Expert policies. Standard mode disables associated-target expansion, on-disk file deletion, protected/PWA storage, broad discovery, and other higher-risk options.
- A recoverable Manifest V3 job state machine with monotonic cooperative cancellation, bounded discovery/concurrency, run-wide duration/query/record budgets, adapter timeouts, and explicit unknown outcomes.
- Versioned, correlated, sender-validated messages with payload bounds and response deadlines; stored approvals are rejected if their current settings/target/private context, complete displayed impact/review, host-permission inventory, file IDs, or confirmations do not reconstruct exactly.
- A privacy-minimized preflight inventory that displays exact target grants separately from relevant broader/all-site pre-existing host access while omitting unrelated hostnames, plus a durable exact target-access lease created before any normal-window browser prompt. Broader and other pre-existing grants are preserved; recovery state remains until every temporary exact pattern is proved absent after completion, cancellation, expiry, failure, reset, or restart.
- A temporary `declarativeNetRequest` shield whose recovery intent is persisted before mutation and forgotten only after diagnostics prove the owned rule range empty.
- Central report redaction, short default retention, SHA-256 content checksums, and evidence states that do not turn failed or timed-out verification into zero.
- Keyboard and screen-reader semantics, live status messages, visible focus, forced-colors support, reduced-motion behavior, and destructive confirmation states.
- A normalized runtime/source artifact builder with explicit closures, root-level `manifest.json`, checksum inventory, runtime SBOM, exact path/byte/timestamp parity, a stored source ZIP designed for cross-platform byte reproducibility, a canonical `dist/current/` index, transactional version updates covering the runtime and every stable release input, and evidence that cannot be rebound automatically to untested bytes. The compressed runtime ZIP is not claimed byte-identical across operating systems without a recorded two-host comparison.

Automated checks establish design and code-level evidence. ChatGPT in-app Browser synthetic UI checks, when recorded, remain separate from installed-extension proof. The owner has approved the exact monotonic public-candidate version recorded in `product-identity.json`; installed Chrome/Brave behavior, accessibility, media, performance, exact-head repository controls, name-collision/legal review, and remote provenance remain separate gates until retained evidence exists.

## Safety boundary

SiteWipe is designed to reject:

- global or time-based `chrome.browsingData` removal;
- data types outside its origin-scoped allowlist;
- browser-internal, extension, file, credential-bearing, malformed, public-suffix-only, and unknown-suffix targets;
- protected Chrome/Brave account and Sync service targets;
- cleanup before a valid preflight approval token is consumed;
- associated targets outside the configured, preflight-bound scope and downloaded-file IDs outside the preflight snapshot;
- page scrub execution in the page's `MAIN` JavaScript world.

These categories are deliberately outside every cleanup path: passwords, passkeys/WebAuthn credentials, bookmarks, browser Sync/account state, autofill profiles, and payment methods. Chromium exposes form-data removal as a profile-wide operation that can affect saved payment data, so this project does not call it.

No browser extension can safely erase server, ISP, DNS-provider, VPN, firewall, operating-system, enterprise, synchronized, or unexposed browser-network-stack records. Browser APIs can also fail, time out, withhold private-window access, or leave unsupported residue. Reports preserve those limitations as limitations.

## Architecture

```mermaid
flowchart LR
  UI["Popup: visible normalized target"] --> Preflight["Read-only scope and impact preflight"]
  Preflight --> Choice{"Saved direct authorization?"}
  Choice -->|no| Review["Complete scope + impact review"]
  Review --> Activate["Explicit final activation"]
  Choice -->|yes| Activate
  Activate --> Lease["Durable temporary-access lease"]
  Lease --> Contract["Consumed single-use approval"]
  Contract --> Job["Persistent cleanup job"]
  Job --> Shield["Tracked DNR request shield"]
  Job --> Discovery["Bounded scope discovery"]
  Discovery --> Adapters["Cookies · tabs · origin storage · history · downloads"]
  Adapters --> Verify["Exposed-residue verification"]
  Verify --> Report["Redaction · checksum · short retention"]
  Shield --> Recovery["Clear + diagnose + forget"]
  Recovery --> Report
```

Browser-specific responsibilities live in separate modules under [`src/background`](./src/background), while pure scope, report, message, and state contracts live under [`src/shared`](./src/shared). The reviewed authorization/report boundary is isolated in `cleanup-authorization.js`; the remaining service-worker orchestration is still comparatively large and is tracked as a maintainability risk rather than described as small.

## Local review

Requirements: Node.js 24 or later and npm 11 or later.

```powershell
npm ci --ignore-scripts
npm run check
npm run test:coverage
npm run build:release-candidate
npm run verify:release-candidate
```

`npm run check:publication-gates` is expected to fail until every human, browser, remote-repository, media, and provenance decision has evidence. A passing unit suite is not publication approval.

For an unpacked, disposable-profile review:

1. Open `chrome://extensions` or `brave://extensions` in a disposable browser profile.
2. Enable Developer mode.
3. Choose **Load unpacked** and select this repository's `src` directory.
4. Use synthetic targets and data only.
5. With the setting off, verify that Standard and Expert show the fresh detailed review and require every applicable acknowledgement.
6. Explicitly enable **Skip detailed cleanup review completely**, accept its Settings warning, and verify that Standard and Expert show **Clean now** and use one SiteWipe popup action after a hidden read-only preflight. Expert file deletion must remain bound to the preflight IDs even though the per-run typed phrase is skipped.
7. Verify that a native target-access prompt may still add a browser-controlled interaction; denial/abandonment starts no cleanup. For a private-source run, first enable **Allow in incognito** and pre-grant exact target access because SiteWipe cannot do either itself.

Do not test destructive options against a daily browser profile, real accounts, personal history, or irreplaceable downloads.

## Permissions at a glance

The default install has no required host pattern. Read-only preflight uses no new target host grant. It inventories granted host patterns so detailed review and direct-run reports can distinguish exact target access from broader/all-site pre-existing access; broader grants are preserved and never widen cleanup scope. After detailed final approval—or from **Clean now** when the direct setting is enabled—SiteWipe requests only missing preflight-bound `http`/`https` patterns for a normal-source run and then submits the single-use cleanup request. Chrome/Brave controls its own permission prompt, so one SiteWipe action can still require an additional native confirmation. Before a normal-window prompt can appear, SiteWipe durably records exactly which requested patterns already existed and which would be temporary. Completion, cancellation, expiry, failure, restart maintenance, and extension-local reset reconcile only temporary exact patterns; the record remains until Chrome/Brave proves them absent. A private-source direct run requires **Allow in incognito** and exact target access before preflight. `webNavigation` is optional, used only for explicitly enabled Expert embedded-frame discovery, and removed/persisted off in Standard, on initial Expert entry, on feature disable, and on reset.

Named permissions cover origin-scoped browser data, cookies, tabs, history, download records, local extension state, isolated-world scripting, extension-owned DNR session rules, the side panel, and scheduled maintenance. The project intentionally removed `sessions` and `contentSettings` from the manifest.

See [`docs/permissions.md`](./docs/permissions.md), [`docs/permission-policy-matrix.md`](./docs/permission-policy-matrix.md), [`docs/decisions/0001-permission-reduction.md`](./docs/decisions/0001-permission-reduction.md), and [`docs/decisions/0011-optional-direct-cleanup.md`](./docs/decisions/0011-optional-direct-cleanup.md) for the threat model and alternatives.

## Evidence and limitations

- [`docs/claim-evidence.md`](./docs/claim-evidence.md) maps candidate public wording to code, automated checks, browser evidence, and approval status.
- [`docs/safety-case.md`](./docs/safety-case.md) states safety claims, assumptions, evidence, and residual risk.
- [`docs/capability-matrix.md`](./docs/capability-matrix.md) distinguishes implemented, partial, unsupported, and not-yet-browser-validated behavior.
- [`docs/release-readiness.md`](./docs/release-readiness.md) is the publication-gate ledger.
- [`docs/testing.md`](./docs/testing.md) separates fast local checks from installed Chrome/Brave evidence.
- [`PRIVACY.md`](./PRIVACY.md) describes local data, retention, redaction, exports, and deletion.

## Repository status and licensing

The owner has approved **SiteWipe** as the custom product identity, selected the [MIT License](./LICENSE) for the first-party project source, confirmed the recorded provenance statement, and authorized public source visibility at [`NouraldinFarge/SiteWipe`](https://github.com/NouraldinFarge/SiteWipe). Anonymous access to the repository is independently reachable. The default branch still carries the older public baseline until this reviewed candidate is proposed and passes its exact-head controls. The package remains `private: true` solely to prevent accidental npm publication. A tag, binary release, store submission, and professional-profile promotion remain separately gated by exact-artifact evidence and review. Known exact-name marketplace collisions remain disclosed and legal clearance is not claimed.

Third-party material is not relicensed as first-party work and remains governed by its own terms in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md). The current candidate icon has an editable, project-controlled SVG and reproducible PNG provenance under [`assets/brand`](./assets/brand); authentic installed-product media and final store-brand approval remain open.

## AI-assisted development disclosure

This project was developed with substantial AI-agent assistance. AI-produced and human-produced changes are treated as untrusted until reviewed through static checks, adversarial tests, installed-browser tests, and explicit owner approval. The repository does not claim complete hand-written authorship.

## Documentation map

- [Architecture](./docs/architecture.md)
- [Threat model](./docs/threat-model.md)
- [Safety case](./docs/safety-case.md)
- [Permissions](./docs/permissions.md)
- [Privacy data flow](./docs/privacy-data-flow.md)
- [Testing](./docs/testing.md)
- [Performance](./docs/performance.md)
- [Releasing](./docs/releasing.md)
- [Product-name research](./docs/product-name-research.md)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)
