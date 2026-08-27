import { createServer, request as createHttpRequest } from 'node:http';

import { FIXTURE_ALLOWED_METHODS, FIXTURE_ALLOWED_ROUTES, SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

export const LOOPBACK_DENY_PROXY_SCHEMA = 'sitewipe.loopback-deny-proxy.v1';

export async function startLoopbackDenyProxy({
  destinations,
  allowedHosts = SYNTHETIC_FIXTURE_HOSTS,
  allowedRoutes = FIXTURE_ALLOWED_ROUTES,
  allowedMethods = FIXTURE_ALLOWED_METHODS
}) {
  const exactDestinations = validateDestinations(destinations, allowedHosts);
  const exactRoutes = validateExactStrings(allowedRoutes, FIXTURE_ALLOWED_ROUTES, 'proxy route allowlist');
  const exactMethods = validateExactStrings(allowedMethods, FIXTURE_ALLOWED_METHODS, 'proxy method allowlist');
  const ledger = [];
  const sockets = new Set();

  const server = createServer((incoming, outgoing) => {
    void handleProxyRequest({ incoming, outgoing, exactDestinations, exactRoutes, exactMethods, ledger });
  });
  server.on('connect', (request, socket) => {
    ledger.push(ledgerEntry(request, null, 403, 'connect_denied'));
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
    throw new Error('Installed-browser deny proxy did not bind exact IPv4 loopback.');
  }

  return Object.freeze({
    schema: LOOPBACK_DENY_PROXY_SCHEMA,
    host: address.address,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    requestLedger: () => ledger.map((entry) => ({ ...entry })),
    async close() {
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      );
    }
  });
}

async function handleProxyRequest({ incoming, outgoing, exactDestinations, exactRoutes, exactMethods, ledger }) {
  let parsed;
  try {
    parsed = new URL(String(incoming.url || ''));
  } catch {
    reject(outgoing, 400, 'absolute_form_required');
    ledger.push(ledgerEntry(incoming, null, 400, 'absolute_form_required'));
    return;
  }

  const host = canonicalHost(parsed.hostname);
  const destination = exactDestinations.get(host);
  const method = String(incoming.method || '').toUpperCase();
  const pathname = parsed.pathname;
  let reason = null;
  let status = 403;
  if (parsed.protocol !== 'http:') reason = 'scheme_denied';
  else if (parsed.username || parsed.password || parsed.hash) reason = 'authority_denied';
  else if (!destination) reason = 'host_denied';
  else if (String(parsed.port || '80') !== String(destination.port)) reason = 'port_denied';
  else if (!exactMethods.has(method)) {
    reason = 'method_denied';
    status = 405;
  } else if (!exactRoutes.has(pathname)) {
    reason = 'route_denied';
    status = 404;
  } else if (incoming.headers.upgrade) reason = 'upgrade_denied';
  else if (
    incoming.headers['transfer-encoding'] !== undefined ||
    !['', '0'].includes(String(incoming.headers['content-length'] ?? ''))
  ) {
    reason = 'body_denied';
  }

  if (reason) {
    reject(outgoing, status, reason);
    ledger.push(ledgerEntry(incoming, parsed, status, reason));
    return;
  }

  const headers = forwardedHeaders(incoming.headers);
  headers.host = formatAuthority(host, destination.port);
  const upstream = createHttpRequest(
    {
      host: destination.connectHost,
      port: destination.port,
      method,
      path: `${pathname}${parsed.search}`,
      headers
    },
    (response) => {
      const responseHeaders = Object.fromEntries(
        Object.entries(response.headers).filter(([name]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()))
      );
      outgoing.writeHead(response.statusCode || 502, responseHeaders);
      response.pipe(outgoing);
      ledger.push(ledgerEntry(incoming, parsed, response.statusCode || 502, 'forwarded'));
    }
  );
  upstream.once('error', () => {
    if (!outgoing.headersSent) reject(outgoing, 502, 'fixture_unreachable');
    else outgoing.destroy();
    ledger.push(ledgerEntry(incoming, parsed, 502, 'fixture_unreachable'));
  });
  incoming.pipe(upstream);
}

function validateDestinations(destinations, allowedHosts) {
  const hosts = validateExactStrings(allowedHosts, SYNTHETIC_FIXTURE_HOSTS, 'proxy host allowlist');
  if (!destinations || typeof destinations !== 'object' || Array.isArray(destinations)) {
    throw new Error('Installed-browser deny proxy requires an exact destination map.');
  }
  const keys = Object.keys(destinations).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...hosts].sort())) {
    throw new Error('Installed-browser deny proxy destinations differ from the exact synthetic host allowlist.');
  }
  const result = new Map();
  for (const host of keys) {
    const value = destinations[host];
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['connectHost', 'port']) ||
      !isLoopback(value.connectHost) ||
      !Number.isInteger(value.port) ||
      value.port < 1 ||
      value.port > 65535
    ) {
      throw new Error(`Installed-browser deny proxy destination is invalid for ${host}.`);
    }
    result.set(host, Object.freeze({ connectHost: value.connectHost, port: value.port }));
  }
  return result;
}

function validateExactStrings(actual, canonical, label) {
  if (
    !Array.isArray(actual) ||
    JSON.stringify(actual) !== JSON.stringify(canonical) ||
    actual.some((value) => typeof value !== 'string' || !value)
  ) {
    throw new Error(`Installed-browser ${label} differs from the canonical fixture policy.`);
  }
  return new Set(actual);
}

function forwardedHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name, value]) => !HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && value !== undefined
    )
  );
}

function ledgerEntry(request, parsed, status, reason) {
  return {
    method: String(request.method || '').toUpperCase(),
    host: parsed ? canonicalHost(parsed.hostname) : null,
    pathname: parsed?.pathname || null,
    status,
    reason
  };
}

function reject(response, status, reason) {
  const body = Buffer.from(`${JSON.stringify({ ok: false, error: reason })}\n`, 'utf8');
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    Connection: 'close',
    'Content-Length': body.length,
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(body);
}

function canonicalHost(value) {
  return String(value || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
}

function formatAuthority(host, port) {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function isLoopback(value) {
  return value === '127.0.0.1' || value === '::1';
}
