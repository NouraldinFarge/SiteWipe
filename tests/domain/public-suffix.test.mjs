import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PUBLIC_SUFFIX_METADATA, normalizePslHostname, resolvePublicSuffix } from '../../src/shared/public-suffix.js';

const corpusPath = fileURLToPath(new URL('../fixtures/public-suffix-list/test_psl.txt', import.meta.url));

test('bundled PSL metadata identifies a complete pinned snapshot', () => {
  assert.equal(PUBLIC_SUFFIX_METADATA.source, 'https://publicsuffix.org/list/public_suffix_list.dat');
  assert.match(PUBLIC_SUFFIX_METADATA.version, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_UTC$/);
  assert.match(PUBLIC_SUFFIX_METADATA.commit, /^[0-9a-f]{40}$/);
  assert.match(PUBLIC_SUFFIX_METADATA.sha256, /^[0-9A-F]{64}$/);
  assert.equal(PUBLIC_SUFFIX_METADATA.license, 'MPL-2.0');
  assert.equal(PUBLIC_SUFFIX_METADATA.includesPrivateRules, true);
  assert.ok(PUBLIC_SUFFIX_METADATA.counts.total > 9000);
  assert.ok(PUBLIC_SUFFIX_METADATA.counts.wildcard > 200);
  assert.ok(PUBLIC_SUFFIX_METADATA.counts.exception >= 5);
});

test('passes the complete upstream PSL conformance corpus', async (context) => {
  const corpus = await readFile(corpusPath, 'utf8');
  const cases = parseCorpus(corpus);
  assert.equal(cases.length, 78);

  for (const { input, expected } of cases) {
    await context.test(`${String(input)} -> ${String(expected)}`, () => {
      const result = resolvePublicSuffix(input, { allowDefaultRule: true });
      assert.equal(result.registrableDomain, canonicalExpected(expected));
    });
  }
});

test('destructive safety mode fails closed for unknown suffixes', () => {
  const unknown = resolvePublicSuffix('tenant.example-unknown', {
    allowDefaultRule: false
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.knownRule, false);
  assert.equal(unknown.registrableDomain, null);

  const specificationDefault = resolvePublicSuffix('tenant.example-unknown', {
    allowDefaultRule: true
  });
  assert.equal(specificationDefault.ok, true);
  assert.equal(specificationDefault.knownRule, false);
  assert.equal(specificationDefault.registrableDomain, 'tenant.example-unknown');
});

test('normalizes Unicode, punycode, mixed case, and one trailing dot consistently', () => {
  const unicode = resolvePublicSuffix('WWW.食狮.公司.CN.', {
    allowDefaultRule: false
  });
  const punycode = resolvePublicSuffix('www.xn--85x722f.xn--55qx5d.cn', {
    allowDefaultRule: false
  });
  assert.equal(unicode.ok, true);
  assert.equal(unicode.registrableDomain, 'xn--85x722f.xn--55qx5d.cn');
  assert.equal(unicode.registrableDomain, punycode.registrableDomain);
});

function parseCorpus(source) {
  const cases = [];
  const pattern = /^checkPublicSuffix\((null|'[^']*'), (null|'[^']*')\);$/gm;
  for (const match of source.matchAll(pattern)) {
    cases.push({
      input: parseLiteral(match[1]),
      expected: parseLiteral(match[2])
    });
  }
  return cases;
}

function parseLiteral(token) {
  if (token === 'null') return null;
  return token.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function canonicalExpected(value) {
  if (value === null) return null;
  const normalized = normalizePslHostname(value);
  assert.equal(normalized.ok, true, `Expected fixture could not be normalized: ${value}`);
  return normalized.hostname;
}
