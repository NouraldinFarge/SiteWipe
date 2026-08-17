# ADR 0008: Exclude browser form-data cleanup

> **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**

- Status: Accepted
- Date: 2026-08-16

## Context

Historical private prototypes called Chromium's profile-wide `formData` browsing-data path while claiming payment methods were protected. Chrome does not expose a safe site-specific autofill cleanup path, and profile-wide form-data removal can affect saved autofill profiles and payment cards.

## Decision

Never pass `formData` to `chrome.browsingData`, never expose it as an option, and treat autofill profiles and payment methods as protected categories. Reject global/time-based removal and keep these categories in the manifest/test/documentation exclusion set.

## Consequences

Site-specific autofill suggestions may remain and must be managed manually through browser settings. Private prototype archives `1.9.4`–`1.9.7` must remain unpublished; if prior distribution is discovered, the owner must issue an accurate safety notice.
