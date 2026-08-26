export function findCurrentChangelogStageClaims(text, currentVersion) {
  const section = currentVersionSection(text, currentVersion);
  if (section === null) return [`exact current-version section ${currentVersion} is missing`];
  const findings = [];
  for (const clause of proseClauses(section)) {
    if (!hasTransientCurrentStageClaim(clause)) continue;
    if (hasExplicitTransactionBoundary(clause, currentVersion)) continue;
    findings.push(clause);
  }
  return findings;
}

export function findReleaseGuideChronologyClaims(text) {
  const findings = [];
  for (const clause of proseClauses(releaseGuideChronology(text))) {
    if (!hasTransientReleaseGuideClaim(clause)) continue;
    if (hasExplicitHistoricalBoundary(clause)) continue;
    findings.push(clause);
  }
  return findings;
}

export function findDeferredCurrentCandidateFindings(text) {
  const findings = [];
  if (hasNoBrowserResultClaim(text)) {
    findings.push('exact current browser status must be delegated, not asserted as no result');
  }
  if (!hasExactBrowserEvidenceDelegation(text)) {
    findings.push('exact current browser status delegation to docs/evidence/browser-validation.json is missing');
  }
  return findings;
}

export function findReleaseReadinessForwardCandidateFindings(text, currentVersion) {
  const sourceStateLines = text.split(/\r?\n/u).filter((line) => line.startsWith('Source state:'));
  if (sourceStateLines.length !== 1) {
    return ['expected exactly one Source state line'];
  }
  const matches = [
    ...sourceStateLines[0].matchAll(/\bSiteWipe (\d+\.\d+\.\d+) is the forward [^*\r\n]*? candidate\b/gu)
  ];
  if (matches.length !== 1) {
    return ['Source state must identify exactly one active forward SiteWipe candidate'];
  }
  if (matches[0][1] !== currentVersion) {
    return [`Source state forward candidate version ${matches[0][1]} does not match package version ${currentVersion}`];
  }
  return [];
}

const capabilityHeaders = [
  'Surface',
  'Intended scope and method',
  'Code status',
  'Browser evidence',
  'Important limit'
];
const claimHeaders = [
  'Candidate public claim',
  'Source / implementation',
  'Automated verification',
  'Browser/release evidence',
  'Known limitation',
  'Owner approval'
];
const safetyHeaders = [
  'ID',
  'Claim',
  'Implementation evidence',
  'Automated evidence',
  'Browser evidence',
  'Current judgement'
];
const readinessHeaders = ['Gate', 'Status', 'Evidence / next required action'];
const testingHeaders = ['Layer', 'Purpose', 'Current mechanism', 'Evidence status'];
const ownerHeaders = ['Decision', 'Current evidence', 'Current state', 'Consequence of approval'];
const issueHeaders = [
  'ID',
  'Priority',
  'Severity',
  'Confidence',
  'Finding and evidence',
  'User impact',
  'Affected files',
  'Fix / required next action',
  'Regression or validation evidence',
  'Publication effect',
  'State'
];

const ownerReviewStates = new Map([
  ['Product identity', 'Approved identity; uniqueness/legal/store clearance not claimed'],
  [
    'Exact public version',
    'The checked-in version ledger identifies the current forward successor; active evidence governs every technical and publication stage'
  ],
  ['Project license/source model', 'Owner-approved MIT'],
  ['Copyright, authorship, and provenance', 'Owner decision retained; see active technical evidence'],
  ['Initial Git history', 'Published-baseline history retained; active remote evidence governs current alignment'],
  ['Repository destination', 'Owner-approved public-source destination'],
  [
    'Repository/security setup',
    'Public availability retained; active remote evidence governs exact-head and settings status'
  ],
  ['Public-source visibility', 'Authorized and available'],
  [
    'Optional direct cleanup',
    'The authorized semantic invariant set is recorded; active automated and browser evidence governs exact current source and installed status'
  ],
  ['Release/tag/attestation', 'Conditional authorization does not establish eligibility'],
  ['Store submission', 'Conditionally authorized; active stage-specific evidence governs eligibility'],
  [
    'Portfolio/résumé/LinkedIn/Indeed',
    'Conditionally authorized; active claim and destination evidence governs eligibility'
  ]
]);

const exactIssueStateExceptions = new Set([
  'Closed historically; successor tracked separately',
  'MIT/provenance decision recorded; technical status in active evidence',
  'Owner-approved identity retained; known name-collision and legal risk remains documented',
  'Mitigated; installed evidence required',
  'Superseded source remediation; see SW-036',
  'Closed in fixture; semantics corrected under SW-049',
  'Historical consent repair retained; successor same-popup risk remains tracked by SW-046',
  'Historical framework repair retained; authentic executor gap remains tracked by SW-058',
  'Historical provenance repair retained; authentic executor gap remains tracked by SW-058',
  'Fixed in code; quarantined prior output retained'
]);

const stablePointerRequirements = new Map([
  [
    'README.md',
    [
      'exact release, supported-binary, and browser-store-listing status belongs only to active publication evidence.',
      'Exact current default-branch and candidate-head status belongs only to the active remote and publication evidence.',
      'exact current installed-product media and store-brand review status belongs only to the active media and decision evidence.'
    ]
  ],
  ['CONTRIBUTING.md', ['Exact current installed-browser status belongs only to the active browser evidence.']],
  [
    'PRIVACY.md',
    [
      'Exact current default-branch and hosted-policy parity belongs only to the active remote and publication evidence; source availability alone does not establish that parity.'
    ]
  ],
  [
    'docs/git-history-plan.md',
    [
      'Historical plan:',
      'exact current alignment and availability belong only to the active remote decision and a fresh authenticated external capture.'
    ]
  ],
  [
    'docs/private-remote-plan.md',
    [
      'Historical plan:',
      'exact current authorization and remote status belong to the release-readiness ledger, `remote-publication.json`, and a fresh ignored authenticated external capture.'
    ]
  ]
]);

const adrStatusRequirements = new Map([
  [
    'docs/decisions/0001-permission-reduction.md',
    'Accepted for the public-source prerelease; permission-gesture details updated by ADRs 0011 and 0013; exact installed-browser status belongs only to active browser evidence'
  ],
  [
    'docs/decisions/0011-optional-direct-cleanup.md',
    'Accepted for the public-source prerelease; exact installed-browser status belongs only to active browser evidence'
  ]
]);

export function findCurrentStatusSurfaceFindings(repoPath, text) {
  const normalizedPath = repoPath.replaceAll('\\', '/');
  switch (normalizedPath) {
    case 'docs/capability-matrix.md':
      return findCapabilityMatrixFindings(text);
    case 'docs/claim-evidence.md':
      return findClaimEvidenceFindings(text);
    case 'docs/safety-case.md':
      return findSafetyCaseFindings(text);
    case 'docs/release-readiness.md':
      return findReleaseReadinessFindings(text);
    case 'docs/testing.md':
      return findTestingFindings(text);
    case 'docs/owner-review-packet.md':
      return findOwnerReviewPacketFindings(text);
    case 'docs/issue-register.md':
      return findIssueRegisterFindings(text);
    default:
      if (adrStatusRequirements.has(normalizedPath)) {
        return findAdrStatusFindings(text, adrStatusRequirements.get(normalizedPath));
      }
      if (stablePointerRequirements.has(normalizedPath)) {
        return findStablePointerFindings(text, stablePointerRequirements.get(normalizedPath));
      }
      return [];
  }
}

function findCapabilityMatrixFindings(text) {
  const { findings, rows } = namedTable(text, capabilityHeaders, 'core capability');
  if (!rows) return findings;
  findings.push(...rowCountFindings(rows, 16, 'core capability'));
  findings.push(...uniqueKeyFindings(rows, 'Surface', 'core capability'));
  for (const row of rows) {
    const expected =
      row.Surface === 'Origin storage'
        ? 'Exact 1.11.62 remains failed history; active browser evidence governs current exact-artifact status'
        : 'See active browser evidence';
    if (row['Browser evidence'] !== expected) {
      findings.push(`${row.Surface}: Browser evidence must use the normalized active-browser-evidence pointer`);
    }
  }
  return findings;
}

function findClaimEvidenceFindings(text) {
  const { findings, rows } = namedTable(text, claimHeaders, 'claim-evidence');
  if (!rows) return findings;
  findings.push(...rowCountFindings(rows, 23, 'claim-evidence'));
  findings.push(...uniqueKeyFindings(rows, 'Candidate public claim', 'claim-evidence'));
  const activeClaimEvidence =
    /\bactive (?:browser\/release evidence|browser-evidence pointer|automated\/browser evidence|browser\/accessibility evidence)\b/iu;
  for (const row of rows) {
    if (!activeClaimEvidence.test(row['Browser/release evidence'])) {
      findings.push(
        `${shortKey(row['Candidate public claim'])}: Browser/release evidence must use an active evidence pointer`
      );
    } else if (!/\b(?:required before this claim|belongs? (?:only )?to)\b/iu.test(row['Browser/release evidence'])) {
      findings.push(
        `${shortKey(row['Candidate public claim'])}: Browser/release evidence must delegate or state its prerequisite`
      );
    }
    if (row['Owner approval'] !== 'See active decisions') {
      findings.push(`${shortKey(row['Candidate public claim'])}: Owner approval must be "See active decisions"`);
    }
  }
  return findings;
}

function findSafetyCaseFindings(text) {
  const { findings, rows } = namedTable(text, safetyHeaders, 'safety-case');
  if (!rows) return findings;
  findings.push(...rowCountFindings(rows, 19, 'safety-case'));
  findings.push(...uniqueKeyFindings(rows, 'ID', 'safety-case'));
  const currentJudgement =
    'Design and prerequisites retained; exact current source and installed status belongs to active evidence';
  for (const row of rows) {
    const expectedBrowserEvidence =
      row.ID === 'S19'
        ? 'Exact 1.11.62 remains failed history; exact current installed status belongs to active browser evidence'
        : /\brequired\b[^;]*; exact current status belongs to active browser evidence$/u;
    const browserEvidenceMatches =
      typeof expectedBrowserEvidence === 'string'
        ? row['Browser evidence'] === expectedBrowserEvidence
        : expectedBrowserEvidence.test(row['Browser evidence']);
    if (!browserEvidenceMatches) {
      findings.push(`${row.ID}: Browser evidence must use the normalized active-browser-evidence delegation`);
    }
    if (row['Current judgement'] !== currentJudgement) {
      findings.push(`${row.ID}: Current judgement must use the normalized active-evidence delegation`);
    }
  }
  return findings;
}

function findReleaseReadinessFindings(text) {
  const { findings, rows } = namedTable(text, readinessHeaders, 'release-readiness');
  if (!rows) return findings;
  findings.push(...rowCountFindings(rows, 46, 'release-readiness'));
  findings.push(...uniqueKeyFindings(rows, 'Gate', 'release-readiness'));
  for (const row of rows) {
    if (row.Gate === 'Baseline captured before changes') {
      if (row.Status !== 'Passed') findings.push(`${row.Gate}: historical baseline Status must remain "Passed"`);
    } else if (!/^See active .+(?:evidence|decisions|assessment)$/u.test(row.Status)) {
      findings.push(`${row.Gate}: Status must delegate to active evidence or decisions`);
    }
  }
  const versionRows = rows.filter((row) => row.Gate === 'Version transaction');
  if (versionRows.length !== 1) {
    findings.push('expected exactly one Version transaction gate row');
  } else if (/\b\d+\.\d+\.\d+\b|\bSW-\d+\b|\bstaged\b/iu.test(Object.values(versionRows[0]).join(' '))) {
    findings.push('Version transaction gate row must remain outcome-neutral');
  }
  return findings;
}

function findTestingFindings(text) {
  const { findings, rows } = namedTable(text, testingHeaders, 'test-layer');
  if (!rows) return findings;
  findings.push(...rowCountFindings(rows, 13, 'test-layer'));
  findings.push(...uniqueKeyFindings(rows, 'Layer', 'test-layer'));
  for (const [layer, expected] of [
    ['Brave compatibility', 'Exact current status belongs to active browser evidence'],
    ['Performance', 'Exact current status belongs to active performance evidence']
  ]) {
    const matches = rows.filter((row) => row.Layer === layer);
    if (matches.length !== 1) {
      findings.push(`expected exactly one ${layer} test-layer row`);
    } else if (matches[0]['Evidence status'] !== expected) {
      findings.push(`${layer}: Evidence status must use the normalized active-evidence delegation`);
    }
  }
  return findings;
}

function findOwnerReviewPacketFindings(text) {
  const { findings, rows } = namedTable(text, ownerHeaders, 'owner-review');
  if (!rows) return findings;
  findings.push(...rowCountFindings(rows, ownerReviewStates.size, 'owner-review'));
  findings.push(...uniqueKeyFindings(rows, 'Decision', 'owner-review'));
  for (const [decision, expected] of ownerReviewStates) {
    const matches = rows.filter((row) => row.Decision === decision);
    if (matches.length !== 1) {
      findings.push(`expected exactly one ${decision} owner-review row`);
    } else if (matches[0]['Current state'] !== expected) {
      findings.push(`${decision}: Current state must use the normalized decision/evidence wording`);
    }
  }
  return findings;
}

function findIssueRegisterFindings(text) {
  const { findings, rows } = namedTable(text, issueHeaders, 'issue-register');
  if (!rows) return findings;
  findings.push(...uniqueKeyFindings(rows, 'ID', 'issue-register'));
  for (const row of rows) {
    if (!/^SW-\d+$/u.test(row.ID)) {
      findings.push(`${row.ID || '<blank>'}: issue-register ID is malformed`);
      continue;
    }
    if (!isOutcomeNeutralIssueState(row.State)) {
      findings.push(`${row.ID}: State must use the normalized outcome-neutral vocabulary`);
    }
  }
  return findings;
}

function findAdrStatusFindings(text, expected) {
  const statusLines = text.match(/^- Status:\s*(.+)$/gmu) ?? [];
  if (statusLines.length !== 1) return ['expected exactly one ADR Status line'];
  const status = statusLines[0].replace(/^- Status:\s*/u, '');
  return status === expected ? [] : ['ADR Status must use the normalized active-browser-evidence delegation'];
}

function findStablePointerFindings(text, requiredMarkers) {
  return requiredMarkers
    .filter((marker) => !text.includes(marker))
    .map((marker) => `required stable current-status pointer is missing: ${marker}`);
}

function isOutcomeNeutralIssueState(state) {
  if (exactIssueStateExceptions.has(state)) return true;
  if (/\b(?:pending|staged|blocked|incomplete|unrun|restart(?:ed|s)?)\b/iu.test(state)) return false;
  if (/\b(?:has|have) not (?:yet )?run\b|\bno (?:fresh|current|current-version)\b[^.;]*\bresult\b/iu.test(state)) {
    return false;
  }
  if (/\bfailed\b/iu.test(state)) return false;
  if (/\bpassed\b/iu.test(state) && !/\bpassed in superseded local history\b/iu.test(state)) return false;
  if (/\bopen\b/iu.test(state) && !/\brisk remains open\b/iu.test(state)) return false;
  return (
    /^(?:Historical|Corrective source|Source correction|Fixed in (?:code|source|source documentation)|Narrow containment|Options correction|Harness(?: portability)?|Stable status-truth defect|Superseded by|Authentic installed-browser executor gap)\b/u.test(
      state
    ) && /(?:\bactive\b[^.;]*\bevidence\b|\bactive evidence\b)/iu.test(state)
  );
}

function namedTable(text, expectedHeaders, label) {
  const lines = text.split(/\r?\n/u);
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const cells = markdownCells(lines[index]);
    if (!cells || !sameCells(cells, expectedHeaders)) continue;
    const separator = markdownCells(lines[index + 1] ?? '');
    if (!separator || separator.length !== cells.length || !separator.every(isTableSeparator)) continue;
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length) {
      const rowCells = markdownCells(lines[cursor]);
      if (!rowCells) break;
      if (rowCells.length !== cells.length) {
        return { findings: [`${label} table has a malformed row at line ${cursor + 1}`], rows: null };
      }
      rows.push(Object.fromEntries(cells.map((header, cellIndex) => [header, rowCells[cellIndex]])));
      cursor += 1;
    }
    matches.push(rows);
  }
  if (matches.length !== 1) {
    return { findings: [`expected exactly one ${label} table with the normalized headers`], rows: null };
  }
  return { findings: [], rows: matches[0] };
}

function markdownCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = [];
  let current = '';
  let escaped = false;
  let inCode = false;
  for (const character of trimmed.slice(1, -1)) {
    if (character === '`' && !escaped) inCode = !inCode;
    if (character === '|' && !escaped && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
    if (character === '\\' && !escaped) escaped = true;
    else escaped = false;
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(cell) {
  return /^:?-{3,}:?$/u.test(cell);
}

function sameCells(left, right) {
  return left.length === right.length && left.every((cell, index) => cell === right[index]);
}

function rowCountFindings(rows, expected, label) {
  return rows.length === expected ? [] : [`${label} table must contain exactly ${expected} data rows`];
}

function uniqueKeyFindings(rows, key, label) {
  const seen = new Set();
  const findings = [];
  for (const row of rows) {
    const value = row[key];
    if (!value) findings.push(`${label} table contains a blank ${key}`);
    else if (seen.has(value)) findings.push(`${label} table contains duplicate ${key}: ${shortKey(value)}`);
    seen.add(value);
  }
  return findings;
}

function shortKey(value) {
  return value.length <= 72 ? value : `${value.slice(0, 69)}...`;
}

function currentVersionSection(text, currentVersion) {
  const currentHeading = `## ${currentVersion} `;
  const currentStart = text.indexOf(currentHeading);
  if (currentStart < 0) return null;
  const nextStart = text.indexOf('\n## ', currentStart + currentHeading.length);
  return text.slice(currentStart, nextStart < 0 ? text.length : nextStart);
}

function hasExplicitTransactionBoundary(line, currentVersion) {
  const normalized = line.toLowerCase();
  return (
    normalized.includes('transaction boundary') &&
    (normalized.includes(`at the ${currentVersion} transaction boundary`) ||
      normalized.includes('at the current transaction boundary'))
  );
}

function releaseGuideChronology(text) {
  const firstProcedureHeading = text.search(/^##\s+/mu);
  return firstProcedureHeading < 0 ? text : text.slice(0, firstProcedureHeading);
}

function proseClauses(text) {
  return text
    .split(/\r?\n/u)
    .flatMap((line) => line.split(/;\s*|(?<=[.!?])\s+(?=[A-Z])/u))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasExplicitHistoricalBoundary(clause) {
  const normalized = clause.toLowerCase();
  return (
    /^(?:[-*]\s*)?(?:historical(?:ly)?\b|(?:at|for|in) (?:that |the |this )?historical\b)/u.test(normalized) ||
    /\bat (?:the )?(?:current|\d+\.\d+\.\d+) transaction boundary\b/u.test(normalized) ||
    /\bat (?:the )?(?:current|\d+\.\d+\.\d+) stable-input seal boundary\b/u.test(normalized) ||
    /\bat the time\b[^.;\n]*\b(?:sealed|transaction boundary)\b/u.test(normalized) ||
    /\bat that (?:historical )?(?:boundary|point|stage|time)\b/u.test(normalized)
  );
}

function hasTransientReleaseGuideClaim(clause) {
  const normalized = clause.toLowerCase();
  return (
    /\bmust (?:be )?restart(?:ed)?\b/u.test(normalized) ||
    /\bcurrent(?:-version)? validation\b[^.;\n]*\brestarts?\b/u.test(normalized)
  );
}

function hasTransientCurrentStageClaim(line) {
  const normalized = line.toLowerCase();
  const currentSubject = /\b(?:fresh|current|current-version)\b/u.test(normalized);
  if (!currentSubject) return false;
  return (
    /\b(?:is|are|remain|remains) (?:pending|unrun)\b/u.test(normalized) ||
    /\b(?:has|have) not (?:yet )?run\b/u.test(normalized) ||
    /\bmust (?:run|restart)\b/u.test(normalized) ||
    /\bno (?:fresh|current|current-version)\b[^.\n]*\bresult exists\b/u.test(normalized)
  );
}

function hasNoBrowserResultClaim(text) {
  return proseClauses(text).some((clause) => {
    const normalized = clause.toLowerCase();
    return (
      /\bno\b[^.;\n]{0,120}\bbrowser results?\b[^.;\n]{0,120}\b(?:exists?|is|are) (?:recorded|available)\b/u.test(
        normalized
      ) ||
      /\bno\b[^.;\n]{0,120}\bbrowser results? exists?\b/u.test(normalized) ||
      /\bthere (?:is|are) no\b[^.;\n]{0,120}\bbrowser results?\b/u.test(normalized)
    );
  });
}

function hasExactBrowserEvidenceDelegation(text) {
  return proseClauses(text).some((clause) => {
    const normalized = clause.toLowerCase().replaceAll('`', '');
    return (
      /\bexact current browser (?:results?|status) (?:belong|belongs) only to docs\/evidence\/browser-validation\.json(?=$|[\s),;:]|\.$)/u.test(
        normalized
      ) ||
      /\bexact current browser (?:results?|status) (?:is|are) (?:delegated to|governed by|authoritative only through) docs\/evidence\/browser-validation\.json(?=$|[\s),;:]|\.$)/u.test(
        normalized
      ) ||
      /(?:^|\s)docs\/evidence\/browser-validation\.json (?:is|remains) the (?:only )?authoritative source for exact current browser (?:results?|status)\b/u.test(
        normalized
      )
    );
  });
}
