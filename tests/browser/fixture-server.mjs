import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(directory, 'fixtures');
const sourceDirectory = resolve(directory, '..', '..', 'src');
const fixtureVersion = 'sitewipe-synthetic-v1';
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
    '/sidepanel-browser-mock.js',
    { file: resolve(fixtureDirectory, 'sidepanel-browser-mock.js'), type: 'text/javascript; charset=utf-8' }
  ]
]);

export async function startFixtureServer({ host = '127.0.0.1', port = 0 } = {}) {
  const requestCounts = new Map();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'fixture.invalid'}`);
      const requestHost = normalizedHost(request.headers.host);
      requestCounts.set(requestHost, (requestCounts.get(requestHost) || 0) + 1);
      applySecurityHeaders(response);

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
            '<script src="/options-browser-mock.js"></script>\n    <script type="module" src="options.js"></script>'
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
      sendJson(response, 500, { ok: false, error: error?.message || String(error) });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic fixture server did not expose a TCP port.');
  return {
    server,
    host,
    port: address.port,
    fixtureVersion,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())))
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const fixture = await startFixtureServer({ port: Number(process.env.SITEWIPE_FIXTURE_PORT) || 43819 });
  console.log(
    JSON.stringify(
      {
        status: 'ready',
        fixtureVersion: fixture.fixtureVersion,
        loopbackUrl: fixture.url,
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

function normalizedHost(value) {
  return String(value || 'fixture.invalid')
    .replace(/:\d+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9.:[\]-]/g, '')
    .slice(0, 253);
}

function normalizedScale(value) {
  return ['small', 'medium', 'large'].includes(value) ? value : 'small';
}
