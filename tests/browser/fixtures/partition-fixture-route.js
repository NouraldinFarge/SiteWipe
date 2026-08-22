export const PARTITION_FIXTURE_HOST = 'chips.localhost';
export const PARTITION_PROBE_PATH = '/partition-probe';
export const PARTITION_PROBE_FRAME_PATH = '/partition-probe/frame';

export function partitionEmbedMode({ pathname = '/', embed = null } = {}) {
  if (pathname === PARTITION_PROBE_PATH) return 'probe';
  return embed === '1' ? 'seed' : null;
}

export function isReadOnlyPartitionProbe(pathname) {
  return pathname === PARTITION_PROBE_PATH || pathname === PARTITION_PROBE_FRAME_PATH;
}

export function isPartitionProbeFrame(pathname) {
  return pathname === PARTITION_PROBE_FRAME_PATH;
}

export function fixtureControlPolicy(pathname) {
  const readOnly = isReadOnlyPartitionProbe(pathname);
  return Object.freeze({
    readOnly,
    allowSeed: !readOnly,
    allowReset: !readOnly,
    allowDownload: !readOnly
  });
}

export function createFixtureApi({ pathname, seedFixture, snapshotFixture, resetFixture, version, scale }) {
  const policy = fixtureControlPolicy(pathname);
  const api = { snapshotFixture, version, scale, readOnly: policy.readOnly };
  if (policy.allowSeed) api.seedFixture = seedFixture;
  if (policy.allowReset) api.resetFixture = resetFixture;
  return Object.freeze(api);
}

export function fixtureStartupAction({ pathname = '/', autoseed = null } = {}) {
  if (isPartitionProbeFrame(pathname)) return 'snapshot';
  if (isReadOnlyPartitionProbe(pathname)) return null;
  return autoseed === '1' ? 'seed' : null;
}

export function partitionFrameUrl({ mode, port = '', scale = 'small' }) {
  if (mode !== 'seed' && mode !== 'probe') throw new TypeError('Partition fixture mode must be seed or probe.');
  if (!['small', 'medium', 'large'].includes(scale)) throw new TypeError('Partition fixture scale is invalid.');

  const normalizedPort = String(port);
  if (normalizedPort && !/^\d{1,5}$/.test(normalizedPort)) throw new TypeError('Partition fixture port is invalid.');

  const authority = normalizedPort ? `${PARTITION_FIXTURE_HOST}:${normalizedPort}` : PARTITION_FIXTURE_HOST;
  const pathname = mode === 'probe' ? PARTITION_PROBE_FRAME_PATH : '/';
  const url = new URL(`http://${authority}${pathname}`);
  url.searchParams.set('scale', scale);
  url.searchParams.set('thirdparty', '1');
  if (mode === 'seed') url.searchParams.set('autoseed', '1');
  return url.href;
}
