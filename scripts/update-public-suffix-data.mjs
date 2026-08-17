import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { domainToASCII, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PSL_URL = 'https://publicsuffix.org/list/public_suffix_list.dat';
const PRIVATE_MARKER = '// ===BEGIN PRIVATE DOMAINS===';
const ICANN_MARKER = '// ===BEGIN ICANN DOMAINS===';

const bytes = await download(PSL_URL);
const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const version = requiredMatch(sourceText, /^\/\/ VERSION:\s*(.+)$/m, 'PSL version');
const commit = requiredMatch(sourceText, /^\/\/ COMMIT:\s*([0-9a-f]{40})$/m, 'PSL commit');
const sha256 = digest(bytes);

if (!sourceText.includes('// License, v. 2.0.')) {
  throw new Error('The downloaded PSL is missing its MPL-2.0 notice.');
}
if (!sourceText.includes(ICANN_MARKER) || !sourceText.includes(PRIVATE_MARKER)) {
  throw new Error('The downloaded PSL is missing required ICANN/PRIVATE section markers.');
}

const parsed = parseRules(sourceText);
assertRepresentativeRules(parsed);

const repositoryBase = `https://raw.githubusercontent.com/publicsuffix/list/${commit}`;
const [testBytes, licenseBytes] = await Promise.all([
  download(`${repositoryBase}/tests/test_psl.txt`),
  download(`${repositoryBase}/LICENSE`)
]);
const testText = new TextDecoder('utf-8', { fatal: true }).decode(testBytes);
if ((testText.match(/^checkPublicSuffix\(/gm) || []).length < 70) {
  throw new Error('The upstream PSL conformance corpus is unexpectedly small.');
}
const licenseText = new TextDecoder('utf-8', { fatal: true }).decode(licenseBytes);
if (!licenseText.startsWith('Mozilla Public License Version 2.0')) {
  throw new Error('The upstream PSL license is not the expected MPL-2.0 text.');
}

const generatedModule = renderModule({
  version,
  commit,
  sha256,
  sourceBytes: bytes.byteLength,
  ...parsed
});

const outputs = [
  ['src/shared/public-suffix-data.js', new TextEncoder().encode(generatedModule)],
  ['third_party/public-suffix-list/public_suffix_list.dat', bytes],
  ['third_party/public-suffix-list/LICENSE', licenseBytes],
  ['tests/fixtures/public-suffix-list/test_psl.txt', testBytes],
  [
    'third_party/public-suffix-list/metadata.json',
    new TextEncoder().encode(
      `${JSON.stringify(
        {
          source: PSL_URL,
          version,
          commit,
          bytes: bytes.byteLength,
          sha256,
          testCorpus: {
            source: `${repositoryBase}/tests/test_psl.txt`,
            bytes: testBytes.byteLength,
            sha256: digest(testBytes),
            cases: (testText.match(/^checkPublicSuffix\(/gm) || []).length,
            license: 'CC0-1.0'
          },
          license: {
            expression: 'MPL-2.0',
            source: `${repositoryBase}/LICENSE`,
            bytes: licenseBytes.byteLength,
            sha256: digest(licenseBytes)
          },
          generatedModule: 'src/shared/public-suffix-data.js',
          generator: 'scripts/update-public-suffix-data.mjs'
        },
        null,
        2
      )}\n`
    )
  ]
];

for (const [relativePath, outputBytes] of outputs) {
  const outputPath = resolve(ROOT, relativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, outputBytes);
}

console.log(
  JSON.stringify(
    {
      source: PSL_URL,
      version,
      commit,
      bytes: bytes.byteLength,
      sha256,
      counts: parsed.counts,
      testCorpusCases: (testText.match(/^checkPublicSuffix\(/gm) || []).length,
      outputs: outputs.map(([path]) => path)
    },
    null,
    2
  )
);

async function download(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'SiteWipe-PSL-updater/1.0' },
    redirect: 'error'
  });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function parseRules(text) {
  const sections = {
    icann: { exact: new Set(), wildcard: new Set(), exception: new Set() },
    private: { exact: new Set(), wildcard: new Set(), exception: new Set() }
  };
  let section = null;

  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === ICANN_MARKER) {
      section = 'icann';
      continue;
    }
    if (line === PRIVATE_MARKER) {
      section = 'private';
      continue;
    }
    if (!line || line.startsWith('//')) continue;
    if (!section) throw new Error(`PSL rule appeared outside a recognized section: ${line}`);

    let type = 'exact';
    let body = line;
    if (line.startsWith('!.')) throw new Error(`Malformed exception rule: ${line}`);
    if (line.startsWith('!')) {
      type = 'exception';
      body = line.slice(1);
    } else if (line.startsWith('*.')) {
      type = 'wildcard';
      body = line.slice(2);
    } else if (line.includes('*') || line.includes('!')) {
      throw new Error(`Unsupported PSL rule syntax: ${line}`);
    }

    const ascii = domainToASCII(body).toLowerCase();
    if (!ascii || ascii.includes('/') || ascii.startsWith('.') || ascii.endsWith('.')) {
      throw new Error(`Could not safely convert PSL rule to ASCII: ${line}`);
    }
    sections[section][type].add(ascii);
  }

  const result = {};
  for (const [sectionName, types] of Object.entries(sections)) {
    for (const [typeName, values] of Object.entries(types)) {
      result[`${sectionName}${capitalize(typeName)}`] = [...values].sort();
    }
  }
  result.counts = {
    icann: countSection(sections.icann),
    private: countSection(sections.private),
    total: countSection(sections.icann) + countSection(sections.private),
    exact: sections.icann.exact.size + sections.private.exact.size,
    wildcard: sections.icann.wildcard.size + sections.private.wildcard.size,
    exception: sections.icann.exception.size + sections.private.exception.size
  };
  return result;
}

function renderModule(data) {
  const metadata = {
    source: PSL_URL,
    version: data.version,
    commit: data.commit,
    bytes: data.sourceBytes,
    sha256: data.sha256,
    license: 'MPL-2.0',
    includesPrivateRules: true,
    counts: data.counts
  };
  return [
    '// Generated by scripts/update-public-suffix-data.mjs. Do not edit by hand.',
    '// This Source Code Form is subject to the terms of the Mozilla Public',
    '// License, v. 2.0. If a copy of the MPL was not distributed with this',
    '// file, You can obtain one at https://mozilla.org/MPL/2.0/.',
    `// Source: ${PSL_URL}`,
    `// Snapshot: ${data.version} (${data.commit})`,
    '',
    `export const PUBLIC_SUFFIX_METADATA = Object.freeze(${JSON.stringify(metadata, null, 2)});`,
    '',
    renderArray('ICANN_EXACT_RULES', data.icannExact),
    renderArray('ICANN_WILDCARD_RULES', data.icannWildcard),
    renderArray('ICANN_EXCEPTION_RULES', data.icannException),
    renderArray('PRIVATE_EXACT_RULES', data.privateExact),
    renderArray('PRIVATE_WILDCARD_RULES', data.privateWildcard),
    renderArray('PRIVATE_EXCEPTION_RULES', data.privateException),
    ''
  ].join('\n');
}

function renderArray(name, values) {
  return `export const ${name} = Object.freeze([\n${values.map((value) => `  ${JSON.stringify(value)},`).join('\n')}\n]);\n`;
}

function assertRepresentativeRules(data) {
  const exact = new Set([...data.icannExact, ...data.privateExact]);
  const wildcard = new Set([...data.icannWildcard, ...data.privateWildcard]);
  const exception = new Set([...data.icannException, ...data.privateException]);
  for (const expected of [
    'com',
    'co.uk',
    'blogspot.com',
    'myshopify.com',
    'web.app',
    'azurewebsites.net',
    'github.io',
    'pages.dev',
    'appspot.com',
    'k12.ca.us',
    'com.bd'
  ]) {
    if (!exact.has(expected)) throw new Error(`Required representative PSL rule is missing: ${expected}`);
  }
  if (!wildcard.has('kawasaki.jp')) throw new Error('Required wildcard rule is missing: *.kawasaki.jp');
  if (!exception.has('city.kawasaki.jp')) throw new Error('Required exception rule is missing: !city.kawasaki.jp');
  if (data.counts.total < 9000 || data.counts.wildcard < 200 || data.counts.exception < 5) {
    throw new Error(`PSL rule counts are unexpectedly small: ${JSON.stringify(data.counts)}`);
  }
}

function requiredMatch(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`Downloaded PSL is missing ${label}.`);
  return match[1].trim();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function capitalize(value) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function countSection(section) {
  return section.exact.size + section.wildcard.size + section.exception.size;
}
