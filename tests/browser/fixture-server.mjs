import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(directory, 'fixtures');
const fixtureVersion = 'sitewipe-synthetic-v1';
const assets = new Map([
  ['/', { file: 'fixture.html', type: 'text/html; charset=utf-8' }],
  ['/fixture-page.js', { file: 'fixture-page.js', type: 'text/javascript; charset=utf-8' }],
  ['/fixture-sw.js', { file: 'fixture-sw.js', type: 'text/javascript; charset=utf-8' }]
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
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src http://chips.localhost:*; connect-src 'self'"
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
