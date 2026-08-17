# DRAFT — NOT APPROVED FOR PUBLICATION: Chrome Web Store listing

All wording below is conditional on exact-artifact browser/accessibility/performance evidence, a hosted privacy policy/contact, license/provenance approval, authentic approved media, accurate live dashboard disclosures, and final store-submission authorization.

## Name

SiteWipe

Known exact-name listings already exist. This draft does not claim uniqueness, trademark clearance, or acceptance by the Chrome Web Store.

## Short description (128 characters)

Review browser-exposed data for one site, approve the scope, then clear it with local reports, recovery, and best-effort checks.

## Single purpose

Let the user review and attempt guarded cleanup of browser-exposed data for one explicitly approved site boundary.

## Long description

SiteWipe prepares a read-only scope and impact review for one registrable site—or an explicitly enabled exact local origin—before cleanup. Every Standard and Expert run shows the normalized target, included scope, selected and unsupported categories, known and unknown impacts, temporary site access, request shielding, report retention, limitations, and verification boundary. Cleanup starts only after a separate final approval.

Depending on reviewed settings and browser support, SiteWipe can attempt target-matched cleanup across cookies, origin storage and cache, live-page storage, tabs, history URLs, and download-list records. Expert options can expand the reviewed scope and can optionally remove preflight-captured completed files after a separate typed confirmation. File deletion is irreversible and off by default.

Processing is designed to stay on the device. The reviewed runtime contains no project analytics, advertising, telemetry, developer-controlled server, or remote executable code. Reports are redacted by default; report history is off; the latest eligible report expires after 30 minutes; completed reports are not persisted whenever private-window access is enabled or private context is observed.

SiteWipe uses a bundled Public Suffix List, including PRIVATE rules, to keep hosted-platform tenants separate. Temporary target access and request-shield rules carry recovery records so interruption is visible and extension-owned state can be reconciled after service-worker or browser restart.

Browser APIs are incomplete and asynchronous. “Verification evidence” means best-effort re-query of exposed cookies, tabs, history, and download records—not proof of complete erasure. SiteWipe cannot remove website/server/account records, synchronized state, passwords, passkeys, bookmarks, autofill/payment profiles, ISP/DNS/VPN/firewall/enterprise/OS records, or other data the browser does not expose safely by target.

## Permission disclosure draft

- Browsing data: remove only reviewed origin-scoped supported site buckets; never use a global/time-based cleanup request.
- Cookies: inspect and remove target-matched cookies for the approved host patterns; exact local-origin cookie effects remain host-scoped across ports.
- Tabs: identify, revalidate, update, and close target-matched tabs and display local progress.
- History: find, re-match, and delete individual matching history URLs.
- Downloads: find/erase matching records; Expert-only file removal is off by default, separately confirmed, and irreversible.
- Storage: retain local settings and bounded scrubbed recovery/report state; no `storage.sync` use.
- Scripting: run bundled cleanup/progress code only in the isolated extension world on approved matching pages.
- Declarative Net Request: install temporary target request-blocking session rules and recover only SiteWipe-owned rules.
- Side panel: show detailed local reports, limitations, and exports.
- Alarms: enforce local expiry and retry safe recovery after MV3 suspension.
- Optional web navigation: discover embedded frames only when Expert mode requests and receives that optional permission.
- Optional site access: the manifest declares HTTP/HTTPS ceilings, but each cleanup requests only the exact missing patterns displayed in the final review; the native prompt is not cleanup consent.

## User-data/limited-use disclosure draft

SiteWipe may locally process the entered/active-tab target, matching tab metadata, browser history and download records, cookies/partition metadata, origin/frame URLs, page-storage metadata, permission state, and extension-owned recovery/report data only to provide the user-facing review, cleanup, verification, recovery, and report features described above. It is designed not to sell, advertise with, or transmit this data to the developer or a project server. Local processing still counts as user-data handling. Final answers must match the exact runtime, hosted privacy policy, and live dashboard fields.

## Media plan

Capture exactly five 1280×800 authentic screenshots from the final installed artifact using synthetic disposable-profile data: target entry, complete Standard review, elevated Expert review with safe synthetic file candidate, partial/unknown verification report, and recovery/privacy controls. Prepare one authentic 60–90 second demo. Do not composite nonexistent states, show personal data, or publish any asset before reviewer and owner approval. Verify current dashboard requirements before capture/upload.

## Support/privacy placeholders

Do not invent URLs or contacts. A stable hosted privacy-policy URL and maintained support/security route are publication blockers.
