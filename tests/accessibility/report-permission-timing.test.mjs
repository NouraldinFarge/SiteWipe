import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('report permission labels distinguish before-cleanup authority from after-release inventory', async () => {
  const sidepanel = await readFile(new URL('../../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
  assert.match(sidepanel, /Target site access available before cleanup/);
  assert.match(sidepanel, /Exact required host grants remaining after release/);
  assert.match(sidepanel, /Broader host grants remaining after release/);
  assert.doesNotMatch(sidepanel, /Exact required host grants observed/);
  assert.doesNotMatch(sidepanel, /Broader host grants observed/);
});
