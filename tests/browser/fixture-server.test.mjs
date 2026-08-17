import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { startFixtureServer } from './fixture-server.mjs';

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

    const cookies = await readFixture(fixture.port, '/seed-cookies', 'chips.localhost');
    assert.equal(cookies.status, 200);
    assert.equal(cookies.headers['set-cookie'].length, 2);
    assert.match(cookies.headers['set-cookie'][1], /Partitioned/);

    const missing = await readFixture(fixture.port, '/not-a-fixture', 'lookalike.invalid');
    assert.equal(missing.status, 404);
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
