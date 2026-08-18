# Support

> **Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.**

There is no supported public binary release or support SLA. Public issue intake is not considered available until anonymous repository access succeeds. Do not use this candidate on a primary browser profile or with irreplaceable data.

## Before asking for help

1. Confirm the extension was loaded from this repository's `src` directory in a disposable profile.
2. Record the exact Chrome or Brave version and operating system.
3. Check Options for target-access, incognito-access, active-job, request-shield, and maintenance status.
4. Run maintenance once if an interrupted job or shield warning is shown.
5. Reproduce with a synthetic domain/fixture and the smallest safe settings set.
6. Generate a redacted troubleshooting summary, inspect it manually, and remove unnecessary details.

Do not share an unredacted report, browser profile, cookies, real history, real URLs, tokens, account identifiers, download filenames, local paths, extension IDs, or private-window data.

## Common conditions

**Target access withheld:** review the target again and grant only the displayed `http`/`https` patterns. Newly granted access is intended to be released after the run.

**Private cleanup unavailable:** enable **Allow in incognito** in the browser's extension details. The extension cannot enable this setting.

**Cleanup interrupted:** the service worker may have stopped. The job should become `interrupted`; temporary shield cleanup remains tracked until diagnostics prove the owned rule range empty.

**Residue reported:** a residue count means an exposed browser record remained. An incomplete/unknown result means a required check did not establish a count. Neither result says what exists on servers or in unexposed browser/OS state.

**Downloaded file remains:** Standard mode never removes files. Expert file removal requires a reviewed completed-file count and exact typed confirmation; download-list erasure and file removal are separate operations.

**Report disappeared:** the latest redacted report expires after 30 minutes by default. History is off by default.

## Security issues

Follow [`SECURITY.md`](./SECURITY.md). Do not post security-sensitive details publicly; use GitHub Private Vulnerability Reporting, and retain the report locally if that confidential route is temporarily unavailable.
