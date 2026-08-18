# ADR 0010: Centralize report redaction and avoid stable target hashes

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

- Status: Accepted
- Date: 2026-08-16

## Context

Property-name-only redaction allowed full URLs and paths to survive in free-form labels/messages, and separate export implementations could drift. Stable unsalted domain hashes would remain vulnerable to dictionary enumeration.

## Decision

Use one recursive redaction module for storage, JSON/text/HTML export, bulk history, troubleshooting, debug/support data, and privacy migration. Combine structured sensitive-field replacement with free-form URL, host, IP, extension-ID, local-path, POSIX-path, secret-parameter, and probable-filename detectors; scan the complete serialized output with adversarial canaries; omit stable target hashes; recompute SHA-256 after every transformation.

Redaction is on by default. A full-detail local report/export requires informed opt-in or a separate export warning. The report returned after persistence is the transformed stored report. Whenever private-window access is enabled, or private scope is otherwise observed, the completed report is returned only to the current extension view and is never persisted; the transient response still follows the redaction setting.

## Consequences

Some useful diagnostics are intentionally removed, false positives can reduce detail, and novel sensitive formats can still evade pattern detection. Redaction is documented as risk reduction rather than anonymization. The checksum detects content mismatch only and is not a signature.
