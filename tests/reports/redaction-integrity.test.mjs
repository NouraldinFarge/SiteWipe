import assert from 'node:assert/strict';
import test from 'node:test';

import { addError, addSection, createReport, finishReport } from '../../src/background/report.js';
import { DEFAULT_SETTINGS } from '../../src/shared/constants.js';
import { prepareReportForExport, redactReport, redactSensitiveValue } from '../../src/shared/report-redaction.js';
import { verifyReportIntegrity } from '../../src/shared/report-integrity.js';

const CANARIES = Object.freeze({
  domain: 'canary-private.example',
  token: 'CANARY_TOKEN_8c87b269',
  filename: 'canary-private-report.txt',
  path: 'C:\\Users\\Private Person\\Downloads\\canary-private-report.txt',
  posixPath: '/var/private/sitewipe/canary-artifact.customext',
  uncommonFilename: 'canary-artifact.customext',
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  localhost: 'private.localhost:43119',
  bracketedIpv6: '[fd00:1234:5678::99]:8443',
  bareIpv6: 'fd00:1234:5678::42',
  ipv4: '10.23.45.67',
  uncPath: '\\\\private-host\\sitewipe-share\\Private Person\\download-canary.bin',
  email: 'private.user+sitewipe@example.test',
  username: 'private-user-canary',
  downloadDestination: 'D:\\Private Downloads\\sitewipe-destination-canary.zip',
  bearer: 'Bearer swp_private_8c87b2690a5e'
});

test('privacy defaults redact reports and expire the latest report after 30 minutes', () => {
  assert.equal(DEFAULT_SETTINGS.redactReports, true);
  assert.equal(DEFAULT_SETTINGS.latestReportRetentionMinutes, 30);
  assert.equal(DEFAULT_SETTINGS.keepHistory, false);
});

test('central report redaction removes canaries from schema fields and free-form strings', async () => {
  const report = await buildCanaryReport();
  const redacted = await redactReport(report, {
    profile: 'test',
    canaries: Object.values(CANARIES)
  });
  const serialized = JSON.stringify(redacted);

  for (const canary of Object.values(CANARIES)) {
    assert.equal(serialized.includes(canary), false, `Canary survived redaction: ${canary}`);
  }
  assert.equal(redacted.input, '[redacted]');
  assert.equal(redacted.targetDomain, '[redacted-target]');
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.integrity.algorithm, 'sha256');
  assert.match(redacted.integrity.digest, /^sha256-[0-9a-f]{64}$/);
  assert.equal(await verifyReportIntegrity(redacted), true);
});

test('every export transformation receives a fresh checksum', async () => {
  const report = await buildCanaryReport();
  const full = await prepareReportForExport(report, { redacted: false });
  const redacted = await prepareReportForExport(report, {
    redacted: true,
    canaries: Object.values(CANARIES)
  });

  assert.equal(await verifyReportIntegrity(full), true);
  assert.equal(await verifyReportIntegrity(redacted), true);
  assert.notEqual(full.integrity.digest, redacted.integrity.digest);
  redacted.status = 'tampered-after-checksum';
  assert.equal(await verifyReportIntegrity(redacted), false);
});

test('debug and support payloads use the same free-form scrubber', () => {
  const payload = redactSensitiveValue({
    target: CANARIES.domain,
    label: `History entry https://${CANARIES.domain}/x?token=${CANARIES.token}`,
    message: `Chrome failed at ${CANARIES.path}`,
    details: `POSIX adapter failed at ${CANARIES.posixPath} while reading ${CANARIES.uncommonFilename}`,
    reason: `Local adapters failed at ${CANARIES.localhost}, ${CANARIES.bracketedIpv6}, and ${CANARIES.bareIpv6}`,
    source: `chrome-extension://${CANARIES.extensionId}/page.html`,
    filename: CANARIES.filename,
    nested: {
      userName: CANARIES.username,
      contact: CANARIES.email,
      downloadDestination: CANARIES.downloadDestination,
      opaqueCredential: CANARIES.token,
      unexpected: [
        `Multiple canaries: http://${CANARIES.ipv4}/private?access_token=${CANARIES.token}; ${CANARIES.uncPath}; ${CANARIES.email}; ${CANARIES.bearer}`
      ]
    }
  });
  const serialized = JSON.stringify(payload);
  for (const canary of Object.values(CANARIES)) assert.equal(serialized.includes(canary), false);
});

async function buildCanaryReport() {
  const target = {
    domain: CANARIES.domain,
    displayName: CANARIES.domain,
    matchMode: 'registrable_domain'
  };
  const report = createReport(target, `https://${CANARIES.domain}/private?token=${CANARIES.token}`);
  addSection(report, 'canary', `History entry https://${CANARIES.domain}/x`, 'partial', {
    associatedTargets: [`sibling.${CANARIES.domain}`],
    cookieQueryFailures: [{ source: `url:https://${CANARIES.domain}/?secret=${CANARIES.token}` }],
    filename: CANARIES.filename,
    localPath: CANARIES.path,
    extensionId: CANARIES.extensionId,
    unexpectedNestedObject: {
      userName: CANARIES.username,
      contact: CANARIES.email,
      downloadDestination: CANARIES.downloadDestination,
      opaqueCredential: CANARIES.token,
      mixedMessage: `Copy from ${CANARIES.uncPath} via http://${CANARIES.ipv4}/?secret=${CANARIES.token} using ${CANARIES.bearer}`
    }
  });
  addError(
    report,
    `History entry https://${CANARIES.domain}/x?token=${CANARIES.token}`,
    new Error(`Failed at ${CANARIES.path}`)
  );
  report.status = 'completed_with_warnings';
  return finishReport(report);
}
