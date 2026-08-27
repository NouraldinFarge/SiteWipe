import assert from 'node:assert/strict';
import { request as createHttpRequest } from 'node:http';
import test from 'node:test';

import {
  FIXTURE_ALLOWED_METHODS,
  FIXTURE_ALLOWED_ROUTES,
  SYNTHETIC_FIXTURE_HOSTS,
  startFixtureServer
} from '../fixture-server.mjs';
import { LOOPBACK_DENY_PROXY_SCHEMA, startLoopbackDenyProxy } from './loopback-deny-proxy.mjs';

const runToken = 'a'.repeat(64);

test('deny proxy forwards only the exact synthetic host, port, method, and route policy', async (t) => {
  const fixture = await startFixtureServer({ runToken });
  const proxy = await startLoopbackDenyProxy({ destinations: destinations(fixture.port) });
  t.after(async () => {
    await proxy.close();
    await fixture.close();
  });
  assert.equal(proxy.schema, LOOPBACK_DENY_PROXY_SCHEMA);

  const allowed = await proxyRequest(proxy, {
    method: 'GET',
    target: `http://selected.example.com:${fixture.port}/seed-cookies`,
    headers: { 'X-SiteWipe-Fixture-Token': runToken }
  });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).ok, true);

  assert.equal((await proxyRequest(proxy, { target: `http://evil.invalid:${fixture.port}/health` })).status, 403);
  assert.equal(
    (await proxyRequest(proxy, { target: `http://selected.example.com:${fixture.port + 1}/health` })).status,
    403
  );
  assert.equal(
    (await proxyRequest(proxy, { target: `http://selected.example.com:${fixture.port}/not-allowed` })).status,
    404
  );
  assert.equal(
    (await proxyRequest(proxy, { method: 'POST', target: `http://selected.example.com:${fixture.port}/health` }))
      .status,
    405
  );
  assert.equal(
    (await proxyRequest(proxy, { target: `https://selected.example.com:${fixture.port}/health` })).status,
    403
  );
  assert.equal(
    (
      await proxyRequest(proxy, {
        target: `http://selected.example.com:${fixture.port}/health`,
        headers: { 'Content-Length': '1' },
        body: 'x'
      })
    ).status,
    403
  );

  const ledger = proxy.requestLedger();
  assert.equal(ledger.length, 7);
  assert.equal(ledger[0].reason, 'forwarded');
  assert.equal(JSON.stringify(ledger).includes(runToken), false);
  assert.equal(
    fixture.requestLedger().some((entry) => entry.pathname === '/seed-cookies' && entry.authorized),
    true
  );
});

test('deny proxy rejects CONNECT without opening an upstream tunnel', async (t) => {
  const fixture = await startFixtureServer({ runToken });
  const proxy = await startLoopbackDenyProxy({ destinations: destinations(fixture.port) });
  t.after(async () => {
    await proxy.close();
    await fixture.close();
  });
  const result = await proxyConnect(proxy, 'selected.example.com:443');
  assert.match(result, /^HTTP\/1\.1 403 Forbidden/);
  assert.deepEqual(proxy.requestLedger(), [
    { method: 'CONNECT', host: null, pathname: null, status: 403, reason: 'connect_denied' }
  ]);
});

test('deny proxy rejects widened or non-loopback destination maps before listening', async () => {
  const exact = destinations(43822);
  await assert.rejects(
    startLoopbackDenyProxy({ destinations: { ...exact, 'evil.invalid': { connectHost: '127.0.0.1', port: 43822 } } }),
    /destinations differ/
  );
  await assert.rejects(
    startLoopbackDenyProxy({
      destinations: { ...exact, 'selected.example.com': { connectHost: '192.0.2.1', port: 43822 } }
    }),
    /destination is invalid/
  );
  await assert.rejects(
    startLoopbackDenyProxy({ destinations: exact, allowedMethods: [...FIXTURE_ALLOWED_METHODS, 'POST'] }),
    /method allowlist differs/
  );
  await assert.rejects(
    startLoopbackDenyProxy({ destinations: exact, allowedRoutes: [...FIXTURE_ALLOWED_ROUTES, '/extra'] }),
    /route allowlist differs/
  );
});

function destinations(port) {
  return Object.fromEntries(
    SYNTHETIC_FIXTURE_HOSTS.map((host) => [host, { connectHost: host === '::1' ? '::1' : '127.0.0.1', port }])
  );
}

function proxyRequest(proxy, { method = 'GET', target, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest(
      {
        host: proxy.host,
        port: proxy.port,
        method,
        path: target,
        headers
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    request.once('error', reject);
    request.end(body);
  });
}

function proxyConnect(proxy, authority) {
  return new Promise((resolve, reject) => {
    const request = createHttpRequest({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: authority });
    request.once('connect', (response, socket) => {
      socket.destroy();
      resolve(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`);
    });
    request.once('response', (response) =>
      resolve(`HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}`)
    );
    request.once('error', reject);
    request.end();
  });
}
