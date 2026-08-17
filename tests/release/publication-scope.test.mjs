import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditPublicationScope,
  normalizeGitHubRepositoryUrl,
  parseGitIndexEntries,
  parseNullPaths
} from '../../scripts/publication-scope.mjs';

const objectId = 'a'.repeat(40);

test('Git index and NUL-path parsers preserve repository-relative filenames', () => {
  const entries = parseGitIndexEntries(
    Buffer.from([`100644 ${objectId} 0\tREADME.md`, `100755 ${objectId} 0\tscripts/check.mjs`, ''].join('\0'))
  );
  assert.deepEqual(entries, [
    { mode: '100644', objectId, stage: 0, path: 'README.md' },
    { mode: '100755', objectId, stage: 0, path: 'scripts/check.mjs' }
  ]);
  assert.deepEqual(parseNullPaths(Buffer.from('README.md\0src/manifest.json\0')), ['README.md', 'src/manifest.json']);
});

test('approved GitHub HTTPS and SSH remotes normalize without accepting credentials or lookalikes', () => {
  const expected = 'github.com/nouraldinfarge/sitewipe';
  assert.equal(normalizeGitHubRepositoryUrl('https://github.com/NouraldinFarge/SiteWipe.git'), expected);
  assert.equal(normalizeGitHubRepositoryUrl('git@github.com:NouraldinFarge/SiteWipe.git'), expected);
  assert.equal(normalizeGitHubRepositoryUrl('ssh://git@github.com/NouraldinFarge/SiteWipe.git'), expected);
  assert.equal(normalizeGitHubRepositoryUrl('https://token@github.com/NouraldinFarge/SiteWipe.git'), null);
  assert.equal(normalizeGitHubRepositoryUrl('https://github.example/NouraldinFarge/SiteWipe.git'), null);
  assert.equal(normalizeGitHubRepositoryUrl('https://github.com/NouraldinFarge/SiteWipe/extra'), null);
});

test('an exact ordinary-file Git/source closure with the approved remote passes', () => {
  const result = auditPublicationScope(validScope());
  assert.deepEqual(result.failures, []);
  assert.equal(result.trackedFiles, 2);
  assert.equal(result.publicationFiles, 2);
  assert.equal(result.sourceFiles, 2);
  assert.equal(result.expectedRepositoryIdentity, 'github.com/nouraldinfarge/sitewipe');
});

test('Git-visible omissions and source paths excluded from Git fail closed', () => {
  const result = auditPublicationScope({
    ...validScope(),
    publicationPaths: ['README.md', 'private-notes.txt'],
    sourcePaths: ['README.md', 'scripts/check.mjs']
  });
  assert.ok(result.failures.some((failure) => failure.includes('omitted from the reviewed source closure')));
  assert.ok(result.failures.some((failure) => failure.includes('not tracked in the publication index')));
  assert.ok(result.failures.some((failure) => failure.includes('excluded from Git publication candidates')));
});

test('symlinks, submodules, private paths, collisions, and unresolved index stages are rejected', () => {
  const result = auditPublicationScope({
    ...validScope(),
    indexEntries: [
      indexEntry('120000', 'secret-link'),
      indexEntry('160000', 'vendor/repository'),
      { ...indexEntry('100644', '.env.production'), stage: 2 }
    ],
    publicationPaths: [
      'secret-link',
      'vendor/repository',
      '.env.production',
      'Docs/readme.md',
      'docs/README.md',
      'docs/bad:name.md'
    ],
    sourcePaths: [
      'secret-link',
      'vendor/repository',
      '.env.production',
      'Docs/readme.md',
      'docs/README.md',
      'docs/bad:name.md'
    ]
  });
  assert.ok(result.failures.some((failure) => failure.includes('symbolic link')));
  assert.ok(result.failures.some((failure) => failure.includes('Git submodule')));
  assert.ok(result.failures.some((failure) => failure.includes('prohibited private/generated path')));
  assert.ok(result.failures.some((failure) => failure.includes('case-insensitive path collision')));
  assert.ok(result.failures.some((failure) => failure.includes('unresolved merge stage')));
  assert.ok(result.failures.some((failure) => failure.includes('non-portable or escaping path')));
});

test('outer or nested Git metadata and an unapproved remote fail without echoing its URL', () => {
  const result = auditPublicationScope({
    ...validScope(),
    rootMatches: false,
    gitDirectoryInsideRoot: false,
    parentRepositoryDetected: true,
    nestedGitMarkers: ['src/vendor/.git'],
    fetchRemoteUrls: ['https://example.test/private/repository.git'],
    pushRemoteUrls: ['https://example.test/private/repository.git']
  });
  assert.ok(result.failures.some((failure) => failure.includes('worktree root')));
  assert.ok(result.failures.some((failure) => failure.includes('metadata is outside')));
  assert.ok(result.failures.some((failure) => failure.includes('outer container')));
  assert.ok(result.failures.some((failure) => failure.includes('Nested Git metadata')));
  assert.equal(result.failures.join('\n').includes('example.test'), false);
});

function validScope() {
  return {
    indexEntries: [indexEntry('100644', 'README.md'), indexEntry('100755', 'scripts/check.mjs')],
    publicationPaths: ['README.md', 'scripts/check.mjs'],
    sourcePaths: ['README.md', 'scripts/check.mjs'],
    rootMatches: true,
    gitDirectoryInsideRoot: true,
    parentRepositoryDetected: false,
    nestedGitMarkers: [],
    remoteDecisionApproved: true,
    expectedRepositoryUrl: 'https://github.com/NouraldinFarge/SiteWipe',
    remoteNames: ['origin'],
    fetchRemoteUrls: ['https://github.com/NouraldinFarge/SiteWipe.git'],
    pushRemoteUrls: ['https://github.com/NouraldinFarge/SiteWipe.git']
  };
}

function indexEntry(mode, path) {
  return { mode, objectId, stage: 0, path };
}
