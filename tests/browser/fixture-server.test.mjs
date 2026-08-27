import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { DEFAULT_SETTINGS } from '../../src/shared/constants.js';
import { parseExactFixtureHostHeader, startFixtureServer } from './fixture-server.mjs';
import { createOptionsFixtureDefaults, optionsFixtureDefaultsScript } from './options-fixture-defaults.mjs';
import {
  PARTITION_PROBE_FRAME_PATH,
  createFixtureApi,
  fixtureControlPolicy,
  fixtureStartupAction,
  isReadOnlyPartitionProbe,
  partitionEmbedMode,
  partitionFrameUrl
} from './fixtures/partition-fixture-route.js';

test('partition fixture keeps setup seeding separate from the read-only observation probe', () => {
  assert.equal(partitionEmbedMode({ pathname: '/', embed: '1' }), 'seed');
  assert.equal(partitionEmbedMode({ pathname: '/partition-probe', embed: '1' }), 'probe');
  assert.equal(partitionEmbedMode({ pathname: '/', embed: null }), null);
  assert.equal(isReadOnlyPartitionProbe('/partition-probe'), true);
  assert.equal(isReadOnlyPartitionProbe(PARTITION_PROBE_FRAME_PATH), true);
  assert.equal(fixtureStartupAction({ pathname: '/', autoseed: '1' }), 'seed');
  assert.equal(fixtureStartupAction({ pathname: '/partition-probe', autoseed: '1' }), null);
  assert.equal(fixtureStartupAction({ pathname: PARTITION_PROBE_FRAME_PATH, autoseed: '1' }), 'snapshot');

  assert.deepEqual(fixtureControlPolicy('/partition-probe'), {
    readOnly: true,
    allowSeed: false,
    allowReset: false,
    allowDownload: false
  });
  const fixtureOperations = {
    seedFixture() {},
    snapshotFixture() {},
    resetFixture() {}
  };
  const probeApi = createFixtureApi({
    pathname: PARTITION_PROBE_FRAME_PATH,
    ...fixtureOperations,
    version: 'sitewipe-synthetic-v1',
    scale: 'small'
  });
  assert.equal(Object.isFrozen(probeApi), true);
  assert.equal(probeApi.snapshotFixture, fixtureOperations.snapshotFixture);
  assert.equal('seedFixture' in probeApi, false);
  assert.equal('resetFixture' in probeApi, false);
  const setupApi = createFixtureApi({
    pathname: '/',
    ...fixtureOperations,
    version: 'sitewipe-synthetic-v1',
    scale: 'small'
  });
  assert.equal(setupApi.seedFixture, fixtureOperations.seedFixture);
  assert.equal(setupApi.resetFixture, fixtureOperations.resetFixture);

  const runToken = 'ab'.repeat(32);
  const seedUrl = new URL(partitionFrameUrl({ mode: 'seed', port: 43819, scale: 'small', runToken }));
  assert.equal(seedUrl.hostname, 'chips.localhost');
  assert.equal(seedUrl.pathname, '/');
  assert.equal(seedUrl.searchParams.get('thirdparty'), '1');
  assert.equal(seedUrl.searchParams.get('autoseed'), '1');
  assert.equal(seedUrl.searchParams.get('runToken'), runToken);

  const probeUrl = new URL(partitionFrameUrl({ mode: 'probe', port: 43819, scale: 'medium' }));
  assert.equal(probeUrl.hostname, 'chips.localhost');
  assert.equal(probeUrl.pathname, PARTITION_PROBE_FRAME_PATH);
  assert.equal(probeUrl.searchParams.get('scale'), 'medium');
  assert.equal(probeUrl.searchParams.get('thirdparty'), '1');
  assert.equal(probeUrl.searchParams.has('autoseed'), false);
});

test('fixture Host parsing preserves exact IPv4, IPv6, DNS, and listener-port identity', () => {
  assert.equal(parseExactFixtureHostHeader('127.0.0.1:43819', 43819), '127.0.0.1');
  assert.equal(parseExactFixtureHostHeader('[::1]:43819', 43819), '::1');
  assert.equal(parseExactFixtureHostHeader('selected.example.com:43819', 43819), 'selected.example.com');
  assert.throws(() => parseExactFixtureHostHeader('127.0.0.1:43820', 43819), /port differs/);
  assert.throws(() => parseExactFixtureHostHeader('selected.example.com@evil.invalid:43819', 43819), /Invalid/);
});

test('synthetic browser fixture hides handler diagnostics from the loopback client', async () => {
  const diagnosticSentinel = 'private-fixture-path-and-stack-sentinel';
  const fixture = await startFixtureServer({
    runToken: 'ef'.repeat(32),
    readFixtureFile: async () => {
      throw new Error(diagnosticSentinel);
    }
  });
  try {
    const failure = await readFixture(fixture.port, '/popup/popup.html', '127.0.0.1');
    assert.equal(failure.status, 500);
    assert.deepEqual(JSON.parse(failure.body), {
      ok: false,
      error: 'Synthetic fixture request failed.'
    });
    assert.doesNotMatch(failure.body, new RegExp(diagnosticSentinel, 'u'));
    assert.deepEqual(fixture.requestLedger().at(-1), {
      method: 'GET',
      host: null,
      pathname: null,
      authorized: false,
      status: 500,
      reason: 'handler_error'
    });
  } finally {
    await fixture.close();
  }
});

test('synthetic browser fixture server is loopback-only, host-aware, and deterministic', async () => {
  const runToken = 'cd'.repeat(32);
  const fixture = await startFixtureServer({ runToken });
  try {
    const health = await readFixture(fixture.port, '/health?scale=large', 'alice.blogspot.com');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), {
      ok: true,
      fixtureVersion: 'sitewipe-synthetic-v1',
      host: 'alice.blogspot.com',
      scale: 'large',
      requestCount: 1
    });

    const page = await readFixture(fixture.port, '/?scale=small', 'bob.blogspot.com');
    assert.equal(page.status, 200);
    assert.match(page.body, /Disposable SiteWipe fixture/);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /(?:^|;\s*)style-src 'self' 'unsafe-inline'(?:\s|;|$)/);

    const partitionProbe = await readFixture(fixture.port, '/partition-probe?scale=small', 'selected.example.com');
    assert.equal(partitionProbe.status, 200);
    assert.equal(partitionProbe.headers['set-cookie'], undefined);
    assert.match(partitionProbe.body, /Read-only partition probe/);

    const partitionProbeFrame = await readFixture(
      fixture.port,
      '/partition-probe/frame?scale=small&thirdparty=1&autoseed=1',
      'chips.localhost'
    );
    assert.equal(partitionProbeFrame.status, 200);
    assert.equal(partitionProbeFrame.headers['set-cookie'], undefined);

    const partitionRouteModule = await readFixture(fixture.port, '/partition-fixture-route.js', 'selected.example.com');
    assert.equal(partitionRouteModule.status, 200);
    assert.match(partitionRouteModule.headers['content-type'], /^text\/javascript/);
    assert.match(partitionRouteModule.body, /mode === 'seed'/);
    assert.match(partitionRouteModule.body, /PARTITION_PROBE_FRAME_PATH/);

    const rejectedCookies = await readFixture(fixture.port, '/seed-cookies', 'chips.localhost');
    assert.equal(rejectedCookies.status, 403);
    assert.equal(rejectedCookies.headers['set-cookie'], undefined);

    const cookies = await readFixture(fixture.port, '/seed-cookies', 'chips.localhost', {
      headers: { 'X-SiteWipe-Fixture-Token': runToken }
    });
    assert.equal(cookies.status, 200);
    assert.equal(cookies.headers['set-cookie'].length, 2);
    assert.match(cookies.headers['set-cookie'][1], /Partitioned/);

    const missing = await readFixture(fixture.port, '/not-a-fixture', 'selected.example.com');
    assert.equal(missing.status, 404);
    const rejectedHost = await readFixture(fixture.port, '/health', 'lookalike.invalid');
    assert.equal(rejectedHost.status, 421);
    const rejectedMethod = await readFixture(fixture.port, '/health', '127.0.0.1', { method: 'POST' });
    assert.equal(rejectedMethod.status, 405);
    assert.equal(rejectedMethod.headers.allow, 'GET');
    const rejectedUiAlias = await readFixture(fixture.port, '/popup/popup.html', 'selected.example.com');
    assert.equal(rejectedUiAlias.status, 421);
    const rejectedPort = await readFixture(fixture.port, '/health', '127.0.0.1', {
      hostHeader: `127.0.0.1:${fixture.port + 1}`
    });
    assert.equal(rejectedPort.status, 400);

    const popup = await readFixture(fixture.port, '/popup/popup.html', '127.0.0.1');
    assert.equal(popup.status, 200);
    assert.match(popup.body, /browser-fixture-mock\.js/);
    assert.match(popup.body, /<script type="module" src="popup\.js"><\/script>/);
    const popupModule = await readFixture(fixture.port, '/popup/popup.js', '127.0.0.1');
    assert.equal(popupModule.status, 200);
    assert.match(popupModule.body, /function renderCleanupReview/);
    const popupMock = await readFixture(fixture.port, '/browser-fixture-mock.js', '127.0.0.1');
    assert.equal(popupMock.status, 200);
    assert.match(popupMock.body, /fixtureParameters\.get\('active'\) === 'unsupported'/);
    assert.match(popupMock.body, /fixtureParameters\.get\('direct'\) === '1'/);
    assert.match(popupMock.body, /fixtureParameters\.get\('private'\) === '1'/);
    assert.match(popupMock.body, /fixtureParameters\.get\('transient'\) === '1'/);
    assert.match(popupMock.body, /fixtureParameters\.get\('permission'\) === 'deny'/);
    assert.match(popupMock.body, /fixtureParameters\.get\('permission'\) === 'expire-after-grant'/);
    assert.match(popupMock.body, /fixtureParameters\.get\('mode'\) === 'standard'/);
    assert.match(popupMock.body, /fixtureParameters\.get\('fixtureControls'\) === '1'/);
    assert.match(popupMock.body, /fixtureParameters\.get\('surface'\) === 'tab'/);
    assert.match(popupMock.body, /fixtureDirectOpenSurface/);
    assert.match(popupMock.body, /if \(showFixtureControls\) document\.body\.append\(settingsChangeButton\)/);
    assert.match(popupMock.body, /approvalMode: directCleanup \? 'settings_direct' : 'detailed_review'/);
    assert.match(popupMock.body, /case 'sitewipe\.armCleanupApproval'/);
    assert.match(popupMock.body, /case 'sitewipe\.beginCleanupPermissionPrompt'/);
    assert.match(popupMock.body, /case 'sitewipe\.confirmCleanupPermissionPromptInvocation'/);
    assert.match(popupMock.body, /case 'sitewipe\.confirmCleanupPermissionGrantOutcome'/);
    assert.match(popupMock.body, /case 'sitewipe\.resumeArmedCleanup'/);
    assert.match(popupMock.body, /async getAll\(\)/);
    assert.match(popupMock.body, /onAdded:/);
    assert.match(popupMock.body, /promptGrantObserved/);
    assert.match(popupMock.body, /preRequestTemporaryOriginsAbsent/);
    assert.match(popupMock.body, /fixtureLastApprovalMode/);
    assert.match(popupMock.body, /fixtureHandoffOpenAttempts/);
    assert.match(popupMock.body, /sitewipe\.openCleanupPermissionHandoff/);
    assert.match(popupMock.body, /fixtureExpireAfterNativeGrant/);
    assert.match(popupMock.body, /Unsupported scheme chrome-extension:\. Use http or https domains only\./);
    for (const modulePath of [
      '/shared/constants.js',
      '/shared/messaging.js',
      '/shared/target-scope.js',
      '/background/domain.js',
      '/shared/public-suffix.js',
      '/shared/public-suffix-data.js'
    ]) {
      const moduleResponse = await readFixture(fixture.port, modulePath, '127.0.0.1');
      assert.equal(moduleResponse.status, 200, `${modulePath} must be served for the popup import closure`);
      assert.match(moduleResponse.headers['content-type'], /^text\/javascript/);
    }
    for (const stylesheetPath of ['/shared/theme.css', '/shared/components.css', '/popup/popup.css']) {
      const stylesheetResponse = await readFixture(fixture.port, stylesheetPath, '127.0.0.1');
      assert.equal(stylesheetResponse.status, 200, `${stylesheetPath} must be served for the popup stylesheet closure`);
      assert.match(stylesheetResponse.headers['content-type'], /^text\/css/);
    }

    const options = await readFixture(fixture.port, '/options/options.html', '127.0.0.1');
    assert.equal(options.status, 200);
    assert.match(options.body, /options-browser-defaults\.js/);
    assert.match(options.body, /options-browser-mock\.js/);
    assert.match(options.body, /<script type="module" src="options\.js"><\/script>/);
    const optionsModule = await readFixture(fixture.port, '/options/options.js', '127.0.0.1');
    assert.equal(optionsModule.status, 200);
    assert.match(optionsModule.headers['content-type'], /^text\/javascript/);
    assert.match(optionsModule.body, /from '\.\.\/shared\/storage\.js'/);
    const storageModule = await readFixture(fixture.port, '/shared/storage.js', '127.0.0.1');
    assert.equal(storageModule.status, 200);
    assert.match(storageModule.headers['content-type'], /^text\/javascript/);
    assert.match(storageModule.body, /from '\.\/state-schema\.js'/);
    const stateSchemaModule = await readFixture(fixture.port, '/shared/state-schema.js', '127.0.0.1');
    assert.equal(stateSchemaModule.status, 200);
    assert.match(stateSchemaModule.headers['content-type'], /^text\/javascript/);
    const permissionLifecycle = await readFixture(fixture.port, '/options/permission-lifecycle.js', '127.0.0.1');
    assert.equal(permissionLifecycle.status, 200);
    assert.match(permissionLifecycle.body, /await permissionsApi\.request\(request\)/);
    const optionsMock = await readFixture(fixture.port, '/options-browser-mock.js', '127.0.0.1');
    assert.equal(optionsMock.status, 200);
    assert.match(optionsMock.body, /async contains\(/);
    assert.match(optionsMock.body, /fixtureNamedPermissionRequestUserActivation/);
    assert.match(optionsMock.body, /fixtureParams\.get\('fixtureControls'\) === '1'/);
    assert.match(optionsMock.body, /structuredClone\(productionDefaults\)/);
    const optionsDefaults = await readFixture(fixture.port, '/options-browser-defaults.js', '127.0.0.1');
    assert.equal(optionsDefaults.status, 200);
    assert.equal(optionsDefaults.body, optionsFixtureDefaultsScript());

    const handoff = await readFixture(fixture.port, '/handoff/handoff.html?outcome=deny', '127.0.0.1');
    assert.equal(handoff.status, 200);
    assert.match(handoff.body, /handoff-browser-mock\.js/);
    assert.match(handoff.body, /<script type="module" src="handoff\.js"><\/script>/);
    const handoffMock = await readFixture(fixture.port, '/handoff-browser-mock.js', '127.0.0.1');
    assert.equal(handoffMock.status, 200);
    assert.match(handoffMock.body, /sitewipe\.claimCleanupPermissionHandoff/);
    assert.match(handoffMock.body, /outcome !== 'deny'/);
    assert.match(handoffMock.body, /fixtureHandoffPermissionRequests/);
    assert.match(optionsMock.body, /if \(showFixtureControls\) document\.body\.append\(activeJobButton\)/);

    const sidepanel = await readFixture(fixture.port, '/sidepanel/sidepanel.html?width=320&view=matrix', '127.0.0.1');
    assert.equal(sidepanel.status, 200);
    assert.match(sidepanel.body, /sidepanel-browser-mock\.js/);
    assert.match(sidepanel.body, /<script type="module" src="sidepanel\.js"><\/script>/);
    assert.match(sidepanel.body, /Export redacted JSON/);
    assert.match(sidepanel.body, /Full stored exports — review before sharing/);
    const sidepanelModule = await readFixture(fixture.port, '/sidepanel/sidepanel.js', '127.0.0.1');
    assert.equal(sidepanelModule.status, 200);
    assert.match(sidepanelModule.body, /function renderReportGroup/);
    assert.match(sidepanelModule.body, /function reportExportFilename/);
    const sidepanelMock = await readFixture(fixture.port, '/sidepanel-browser-mock.js', '127.0.0.1');
    assert.equal(sidepanelMock.status, 200);
    assert.match(sidepanelMock.body, /fixtureHorizontalOverflow/);
    assert.match(sidepanelMock.body, /fixtureMatrixVisible/);
    assert.match(sidepanelMock.body, /fixtureMatrixExpanded/);
    assert.match(sidepanelMock.body, /fixtureParameters\.get\('history'\) === 'empty'/);
    assert.match(sidepanelMock.body, /fixtureParameters\.get\('stored'\) === 'full'/);
    assert.match(sidepanelMock.body, /fixtureParameters\.get\('verification'\) \|\| 'verified-zero'/);
    assert.match(sidepanelMock.body, /scenario === 'residue-incomplete'/);
    assert.match(sidepanelMock.body, /scenario === 'incomplete-zero'/);
    assert.match(sidepanelMock.body, /cookies: verificationEvidence\('residue_found', 3\)/);
    assert.match(sidepanelMock.body, /history: verificationEvidence\('failed', null/);
    assert.match(sidepanelMock.body, /history: verificationEvidence\('timed_out', null/);
    assert.match(sidepanelMock.body, /summary\.verificationRemainingTotal = null/);
    assert.match(sidepanelMock.body, /\['warning', 'runtime-error'\]/);
    assert.match(sidepanelMock.body, /fixtureOutcomeBadge/);
    assert.match(sidepanelMock.body, /fixtureHistoryOverview/);
    assert.match(sidepanelMock.body, /fixtureParameters\.get\('matrixSearch'\)/);
    assert.match(sidepanelMock.body, /fixtureParameters\.get\('matrixStatus'\)/);
    assert.match(sidepanelMock.body, /sitewipe\.getReportState/);
    for (const modulePath of [
      '/shared/report-redaction.js',
      '/shared/report-integrity.js',
      '/shared/side-panel-report-binding.js',
      '/shared/verification-evidence.js',
      '/sidepanel/report-outcome.js'
    ]) {
      const moduleResponse = await readFixture(fixture.port, modulePath, '127.0.0.1');
      assert.equal(moduleResponse.status, 200, `${modulePath} must be served for the side-panel import closure`);
      assert.match(moduleResponse.headers['content-type'], /^text\/javascript/);
    }
    const sidepanelStyles = await readFixture(fixture.port, '/sidepanel/sidepanel.css', '127.0.0.1');
    assert.equal(sidepanelStyles.status, 200);
    assert.match(sidepanelStyles.headers['content-type'], /^text\/css/);

    assert.deepEqual(createOptionsFixtureDefaults(), DEFAULT_SETTINGS);
    const ledger = fixture.requestLedger();
    assert.ok(ledger.some((entry) => entry.reason === 'fixture_token_rejected'));
    assert.ok(ledger.some((entry) => entry.reason === 'host_not_allowed'));
    assert.ok(ledger.some((entry) => entry.reason === 'method_not_allowed'));
    assert.ok(ledger.every((entry) => !Object.hasOwn(entry, 'runToken')));
  } finally {
    await fixture.close();
  }
});

function readFixture(port, path, host, { headers = {}, hostHeader = `${host}:${port}`, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { Host: hostHeader, ...headers }
      },
      (response) => {
        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      }
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}
