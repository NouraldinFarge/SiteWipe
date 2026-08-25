import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { optionsFixtureDefaultsScript } from './options-fixture-defaults.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(directory, 'fixtures');
const sourceDirectory = resolve(directory, '..', '..', 'src');
const fixtureVersion = 'sitewipe-synthetic-v1';
export const SYNTHETIC_FIXTURE_HOSTS = Object.freeze([
  '127.0.0.1',
  '::1',
  'alice.blogspot.com',
  'bob.blogspot.com',
  'chips.localhost',
  'localhost',
  'selected.example.com',
  'selected.example.com.evil.invalid',
  'sub.selected.example.com'
]);
const loopbackUiHosts = new Set(['127.0.0.1', '::1', 'localhost']);
const assets = new Map([
  ['/', { file: 'fixture.html', type: 'text/html; charset=utf-8' }],
  ['/partition-probe', { file: 'fixture.html', type: 'text/html; charset=utf-8' }],
  ['/partition-probe/frame', { file: 'fixture.html', type: 'text/html; charset=utf-8' }],
  ['/fixture-page.js', { file: 'fixture-page.js', type: 'text/javascript; charset=utf-8' }],
  ['/partition-fixture-route.js', { file: 'partition-fixture-route.js', type: 'text/javascript; charset=utf-8' }],
  ['/fixture-sw.js', { file: 'fixture-sw.js', type: 'text/javascript; charset=utf-8' }]
]);
const popupAssets = new Map([
  ['/popup/popup.js', { file: resolve(sourceDirectory, 'popup', 'popup.js'), type: 'text/javascript; charset=utf-8' }],
  ['/popup/popup.css', { file: resolve(sourceDirectory, 'popup', 'popup.css'), type: 'text/css; charset=utf-8' }],
  ['/shared/theme.css', { file: resolve(sourceDirectory, 'shared', 'theme.css'), type: 'text/css; charset=utf-8' }],
  [
    '/shared/components.css',
    { file: resolve(sourceDirectory, 'shared', 'components.css'), type: 'text/css; charset=utf-8' }
  ],
  [
    '/shared/constants.js',
    { file: resolve(sourceDirectory, 'shared', 'constants.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/messaging.js',
    { file: resolve(sourceDirectory, 'shared', 'messaging.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/cleanup-mode.js',
    { file: resolve(sourceDirectory, 'shared', 'cleanup-mode.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/target-scope.js',
    { file: resolve(sourceDirectory, 'shared', 'target-scope.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/public-suffix.js',
    { file: resolve(sourceDirectory, 'shared', 'public-suffix.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/public-suffix-data.js',
    { file: resolve(sourceDirectory, 'shared', 'public-suffix-data.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/background/domain.js',
    { file: resolve(sourceDirectory, 'background', 'domain.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/settings-backup.js',
    { file: resolve(sourceDirectory, 'shared', 'settings-backup.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/report-redaction.js',
    { file: resolve(sourceDirectory, 'shared', 'report-redaction.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/report-integrity.js',
    { file: resolve(sourceDirectory, 'shared', 'report-integrity.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/side-panel-report-binding.js',
    {
      file: resolve(sourceDirectory, 'shared', 'side-panel-report-binding.js'),
      type: 'text/javascript; charset=utf-8'
    }
  ],
  [
    '/shared/verification-evidence.js',
    { file: resolve(sourceDirectory, 'shared', 'verification-evidence.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/storage-partition-policy.js',
    { file: resolve(sourceDirectory, 'shared', 'storage-partition-policy.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/maintenance-results.js',
    { file: resolve(sourceDirectory, 'shared', 'maintenance-results.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/shared/host-permissions.js',
    { file: resolve(sourceDirectory, 'shared', 'host-permissions.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/options/options.js',
    { file: resolve(sourceDirectory, 'options', 'options.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/options/permission-lifecycle.js',
    {
      file: resolve(sourceDirectory, 'options', 'permission-lifecycle.js'),
      type: 'text/javascript; charset=utf-8'
    }
  ],
  [
    '/options/options.css',
    { file: resolve(sourceDirectory, 'options', 'options.css'), type: 'text/css; charset=utf-8' }
  ],
  [
    '/handoff/handoff.js',
    { file: resolve(sourceDirectory, 'handoff', 'handoff.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/handoff/handoff.css',
    { file: resolve(sourceDirectory, 'handoff', 'handoff.css'), type: 'text/css; charset=utf-8' }
  ],
  [
    '/sidepanel/sidepanel.js',
    { file: resolve(sourceDirectory, 'sidepanel', 'sidepanel.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/sidepanel/report-outcome.js',
    { file: resolve(sourceDirectory, 'sidepanel', 'report-outcome.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/sidepanel/sidepanel.css',
    { file: resolve(sourceDirectory, 'sidepanel', 'sidepanel.css'), type: 'text/css; charset=utf-8' }
  ],
  [
    '/browser-fixture-mock.js',
    { file: resolve(fixtureDirectory, 'popup-browser-mock.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/options-browser-mock.js',
    { file: resolve(fixtureDirectory, 'options-browser-mock.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/handoff-browser-mock.js',
    { file: resolve(fixtureDirectory, 'handoff-browser-mock.js'), type: 'text/javascript; charset=utf-8' }
  ],
  [
    '/sidepanel-browser-mock.js',
    { file: resolve(fixtureDirectory, 'sidepanel-browser-mock.js'), type: 'text/javascript; charset=utf-8' }
  ]
]);

const dataRoutes = new Set([
  ...assets.keys(),
  '/health',
  '/seed-cookies',
  '/clear-cookies',
  '/fixture-download.txt',
  '/fixture-worker-payload.txt'
]);
const uiRoutes = new Set([
  ...popupAssets.keys(),
  '/popup/popup.html',
  '/options/options.html',
  '/handoff/handoff.html',
  '/sidepanel/sidepanel.html',
  '/options-browser-defaults.js'
]);
export const FIXTURE_ALLOWED_METHODS = Object.freeze(['GET']);
export const FIXTURE_ALLOWED_ROUTES = Object.freeze([...new Set([...dataRoutes, ...uiRoutes])].sort());

export async function startFixtureServer({
  host = '127.0.0.1',
  port = 0,
  allowedHosts = SYNTHETIC_FIXTURE_HOSTS,
  runToken = randomBytes(32).toString('hex')
} = {}) {
  const bindHost = validatedBindHost(host);
  const exactAllowedHosts = validatedAllowedHosts(allowedHosts);
  const exactRunToken = validatedRunToken(runToken);
  const requestCounts = new Map();
  const requestLedger = [];
  let boundPort = null;
  const server = createServer(async (request, response) => {
    try {
      applySecurityHeaders(response);
      const authorization = authorizeFixtureRequest({
        request,
        boundPort,
        allowedHosts: exactAllowedHosts,
        runToken: exactRunToken
      });
      requestLedger.push(authorization.evidence);
      if (!authorization.ok) {
        if (authorization.allow) response.setHeader('Allow', authorization.allow);
        sendJson(response, authorization.status, { ok: false, error: authorization.error });
        return;
      }
      const { url, requestHost } = authorization;
      requestCounts.set(requestHost, (requestCounts.get(requestHost) || 0) + 1);

      if (url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          fixtureVersion,
          host: requestHost,
          scale: normalizedScale(url.searchParams.get('scale')),
          requestCount: requestCounts.get(requestHost)
        });
        return;
      }
      if (url.pathname === '/seed-cookies') {
        const value = encodeURIComponent(`${fixtureVersion}-${requestHost}`);
        response.setHeader('Set-Cookie', [
          `sitewipe_fixture=${value}; Path=/; SameSite=Lax; Max-Age=3600`,
          `sitewipe_partitioned=${value}; Path=/; SameSite=None; Secure; Partitioned; Max-Age=3600`
        ]);
        sendJson(response, 200, { ok: true, host: requestHost });
        return;
      }
      if (url.pathname === '/clear-cookies') {
        response.setHeader('Set-Cookie', [
          'sitewipe_fixture=; Path=/; SameSite=Lax; Max-Age=0',
          'sitewipe_partitioned=; Path=/; SameSite=None; Secure; Partitioned; Max-Age=0'
        ]);
        sendJson(response, 200, { ok: true, host: requestHost });
        return;
      }
      if (url.pathname === '/fixture-download.txt') {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Content-Disposition', 'attachment; filename="sitewipe-synthetic-download.txt"');
        response.end(`${fixtureVersion}\nHarmless disposable integration fixture.\n`);
        return;
      }
      if (url.pathname === '/fixture-worker-payload.txt') {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.end(`${fixtureVersion}-worker-cache`);
        return;
      }

      if (url.pathname === '/popup/popup.html') {
        const popup = await readFile(resolve(sourceDirectory, 'popup', 'popup.html'), 'utf8');
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          popup.replace(
            '<script type="module" src="popup.js"></script>',
            '<script src="/browser-fixture-mock.js"></script>\n    <script type="module" src="popup.js"></script>'
          )
        );
        return;
      }

      if (url.pathname === '/options/options.html') {
        const optionsPage = await readFile(resolve(sourceDirectory, 'options', 'options.html'), 'utf8');
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          optionsPage.replace(
            '<script type="module" src="options.js"></script>',
            '<script src="/options-browser-defaults.js"></script>\n    <script src="/options-browser-mock.js"></script>\n    <script type="module" src="options.js"></script>'
          )
        );
        return;
      }

      if (url.pathname === '/options-browser-defaults.js') {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(optionsFixtureDefaultsScript());
        return;
      }

      if (url.pathname === '/handoff/handoff.html') {
        const handoff = await readFile(resolve(sourceDirectory, 'handoff', 'handoff.html'), 'utf8');
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          handoff.replace(
            '<script type="module" src="handoff.js"></script>',
            '<script src="/handoff-browser-mock.js"></script>\n    <script type="module" src="handoff.js"></script>'
          )
        );
        return;
      }

      if (url.pathname === '/sidepanel/sidepanel.html') {
        const sidepanel = await readFile(resolve(sourceDirectory, 'sidepanel', 'sidepanel.html'), 'utf8');
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          sidepanel.replace(
            '<script type="module" src="sidepanel.js"></script>',
            '<script src="/sidepanel-browser-mock.js"></script>\n    <script type="module" src="sidepanel.js"></script>'
          )
        );
        return;
      }

      const popupAsset = popupAssets.get(url.pathname);
      if (popupAsset) {
        response.statusCode = 200;
        response.setHeader('Content-Type', popupAsset.type);
        response.end(await readFile(popupAsset.file));
        return;
      }

      const asset = assets.get(url.pathname);
      if (!asset) {
        sendJson(response, 404, { ok: false, error: 'Synthetic fixture route not found.' });
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Type', asset.type);
      response.end(await readFile(resolve(fixtureDirectory, asset.file)));
    } catch (error) {
      requestLedger.push({
        method: String(request.method || ''),
        host: null,
        pathname: null,
        authorized: false,
        status: 500,
        reason: 'handler_error'
      });
      sendJson(response, 500, { ok: false, error: error?.message || String(error) });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, bindHost, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic fixture server did not expose a TCP port.');
  boundPort = address.port;
  return {
    server,
    host: bindHost,
    port: address.port,
    fixtureVersion,
    runToken: exactRunToken,
    runTokenSha256: sha256(exactRunToken),
    url: `http://${formatHostForUrl(bindHost)}:${address.port}`,
    policy: Object.freeze({
      allowedHosts: Object.freeze([...exactAllowedHosts]),
      allowedMethods: FIXTURE_ALLOWED_METHODS,
      allowedRoutes: FIXTURE_ALLOWED_ROUTES
    }),
    requestLedger: () => requestLedger.map((entry) => ({ ...entry })),
    close: () =>
      new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())))
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fixture = await startFixtureServer({
    port: Number(process.env.SITEWIPE_FIXTURE_PORT) || 43819,
    runToken: process.env.SITEWIPE_FIXTURE_TOKEN || undefined
  });
  console.log(
    JSON.stringify(
      {
        status: 'ready',
        fixtureVersion: fixture.fixtureVersion,
        loopbackUrl: fixture.url,
        fixtureRunToken: fixture.runToken,
        fixtureRunTokenSha256: fixture.runTokenSha256,
        note: 'Use only with a disposable browser profile and the documented synthetic host-resolver rules.'
      },
      null,
      2
    )
  );
  const close = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function applySecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://chips.localhost:*; connect-src 'self'"
  );
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

function normalizedScale(value) {
  return ['small', 'medium', 'large'].includes(value) ? value : 'small';
}

function authorizeFixtureRequest({ request, boundPort, allowedHosts, runToken }) {
  const method = String(request.method || '').toUpperCase();
  let host = null;
  let pathname = null;
  const reject = (status, reason, error, allow = null) => ({
    ok: false,
    status,
    error,
    allow,
    evidence: { method, host, pathname, authorized: false, status, reason }
  });
  if (!Number.isInteger(boundPort)) {
    return reject(503, 'fixture_not_ready', 'Synthetic fixture is not ready.');
  }
  try {
    host = parseExactFixtureHostHeader(request.headers.host, boundPort);
  } catch {
    return reject(400, 'invalid_host_header', 'Synthetic fixture Host header is invalid.');
  }
  if (!allowedHosts.includes(host)) {
    return reject(421, 'host_not_allowed', 'Synthetic fixture Host is not allowlisted.');
  }
  const requestTarget = String(request.url || '');
  if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
    return reject(400, 'invalid_request_target', 'Synthetic fixture requires an origin-form request target.');
  }
  let url;
  try {
    url = new URL(requestTarget, `http://${formatHostForUrl(host)}:${boundPort}`);
    pathname = url.pathname;
  } catch {
    return reject(400, 'invalid_request_target', 'Synthetic fixture request target is invalid.');
  }
  if (!FIXTURE_ALLOWED_ROUTES.includes(pathname)) {
    return reject(404, 'route_not_allowed', 'Synthetic fixture route is not allowlisted.');
  }
  if (!FIXTURE_ALLOWED_METHODS.includes(method)) {
    return reject(405, 'method_not_allowed', 'Synthetic fixture method is not allowlisted.', 'GET');
  }
  if (uiRoutes.has(pathname) && !loopbackUiHosts.has(host)) {
    return reject(421, 'ui_host_not_allowed', 'Synthetic UI routes require an exact loopback Host.');
  }
  if (pathname === '/partition-probe/frame' && host !== 'chips.localhost') {
    return reject(421, 'partition_frame_host_not_allowed', 'Partition frame route requires chips.localhost.');
  }
  if (['/seed-cookies', '/clear-cookies'].includes(pathname)) {
    const supplied = request.headers['x-sitewipe-fixture-token'];
    if (!sameToken(supplied, runToken)) {
      return reject(403, 'fixture_token_rejected', 'Synthetic fixture mutation token is missing or incorrect.');
    }
  }
  return {
    ok: true,
    url,
    requestHost: host,
    evidence: { method, host, pathname, authorized: true, status: 200, reason: 'allowlisted' }
  };
}

export function parseExactFixtureHostHeader(value, expectedPort) {
  const input = String(value || '');
  if (!input || /[\s,/@\\]/.test(input)) throw new Error('Invalid Host header.');
  const parsed = new URL(`http://${input}/`);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Invalid Host header authority.');
  }
  if (parsed.port !== String(expectedPort)) throw new Error('Host header port differs from the fixture listener.');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

function validatedBindHost(value) {
  const host = String(value || '').toLowerCase();
  if (!['127.0.0.1', '::1'].includes(host)) {
    throw new Error('Synthetic fixture listener must bind an exact IPv4 or IPv6 loopback address.');
  }
  return host;
}

function validatedAllowedHosts(values) {
  if (!Array.isArray(values) || !values.length) throw new Error('Synthetic fixture requires an exact Host allowlist.');
  const normalized = values.map((value) => String(value || '').toLowerCase());
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((host) => !SYNTHETIC_FIXTURE_HOSTS.includes(host))
  ) {
    throw new Error('Synthetic fixture Host allowlist contains a duplicate or noncanonical host.');
  }
  return Object.freeze([...normalized]);
}

function validatedRunToken(value) {
  const token = String(value || '');
  if (!/^[A-Fa-f0-9]{64}$/.test(token)) {
    throw new Error('Synthetic fixture run token must contain exactly 32 random bytes encoded as hexadecimal.');
  }
  return token.toLowerCase();
}

function sameToken(left, right) {
  if (typeof left !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function formatHostForUrl(host) {
  return host.includes(':') ? `[${host}]` : host;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}
