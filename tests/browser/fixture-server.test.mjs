import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { startFixtureServer } from './fixture-server.mjs';
import {
  PARTITION_PROBE_FRAME_PATH,
  createFixtureApi,
  fixtureControlPolicy,
  fixtureStartupAction,
  isReadOnlyPartitionProbe,
  partitionEmbedMode,
  partitionFrameUrl
} from './fixtures/partition-fixture-route.js';

test('partition fixture keeps setup seeding separate from the read-only preservation probe', () => {
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

  const seedUrl = new URL(partitionFrameUrl({ mode: 'seed', port: 43819, scale: 'small' }));
  assert.equal(seedUrl.hostname, 'chips.localhost');
  assert.equal(seedUrl.pathname, '/');
  assert.equal(seedUrl.searchParams.get('thirdparty'), '1');
  assert.equal(seedUrl.searchParams.get('autoseed'), '1');

  const probeUrl = new URL(partitionFrameUrl({ mode: 'probe', port: 43819, scale: 'medium' }));
  assert.equal(probeUrl.hostname, 'chips.localhost');
  assert.equal(probeUrl.pathname, PARTITION_PROBE_FRAME_PATH);
  assert.equal(probeUrl.searchParams.get('scale'), 'medium');
  assert.equal(probeUrl.searchParams.get('thirdparty'), '1');
  assert.equal(probeUrl.searchParams.has('autoseed'), false);
});

test('synthetic browser fixture server is loopback-only, host-aware, and deterministic', async () => {
  const fixture = await startFixtureServer();
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
    assert.match(page.headers['content-security-policy'], /(?:^|;\s*)style-src 'self' 'unsafe-inline'(?:;|$)/);

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

    const cookies = await readFixture(fixture.port, '/seed-cookies', 'chips.localhost');
    assert.equal(cookies.status, 200);
    assert.equal(cookies.headers['set-cookie'].length, 2);
    assert.match(cookies.headers['set-cookie'][1], /Partitioned/);

    const missing = await readFixture(fixture.port, '/not-a-fixture', 'lookalike.invalid');
    assert.equal(missing.status, 404);

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
    assert.match(popupMock.body, /approvalMode: directCleanup \? 'settings_direct' : 'detailed_review'/);
    assert.match(popupMock.body, /case 'sitewipe\.armCleanupApproval'/);
    assert.match(popupMock.body, /case 'sitewipe\.resumeArmedCleanup'/);
    assert.match(popupMock.body, /fixtureLastApprovalMode/);
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
    assert.match(options.body, /options-browser-mock\.js/);
    assert.match(options.body, /<script type="module" src="options\.js"><\/script>/);
    const permissionLifecycle = await readFixture(fixture.port, '/options/permission-lifecycle.js', '127.0.0.1');
    assert.equal(permissionLifecycle.status, 200);
    assert.match(permissionLifecycle.body, /await permissionsApi\.request\(request\)/);
    const optionsMock = await readFixture(fixture.port, '/options-browser-mock.js', '127.0.0.1');
    assert.equal(optionsMock.status, 200);
    assert.match(optionsMock.body, /async contains\(/);
    assert.match(optionsMock.body, /fixtureNamedPermissionRequestUserActivation/);

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
  } finally {
    await fixture.close();
  }
});

function readFixture(port, path, host) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        headers: { Host: `${host}:${port}` }
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
