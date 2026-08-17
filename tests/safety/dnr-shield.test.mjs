import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSiteInput } from '../../src/background/domain.js';
import { createReport } from '../../src/background/report.js';
import {
  buildTemporaryDnrShieldRules,
  clearSiteWipeDnrRules,
  finalizeTemporaryDnrShield,
  installTemporaryDnrShield,
  replaceSiteWipeDnrShieldRules,
  SITEWIPE_DNR_RULE_IDS
} from '../../src/background/dnr-shield.js';

function targetAndReport() {
  const normalized = normalizeSiteInput('https://app.example.com/path?secret=value');
  assert.equal(normalized.ok, true);
  return {
    target: normalized.target,
    report: createReport(normalized.target, normalized.canonicalInput)
  };
}

test('DNR construction and removal stay inside SiteWipe owned rule IDs', async () => {
  const { target } = targetAndReport();
  const built = buildTemporaryDnrShieldRules(target);
  assert.equal(built.rules.length, 1);
  assert.equal(built.rules[0].id, 730000);
  assert.equal(built.rules[0].condition.urlFilter, '||example.com^');

  let request = null;
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: async (value) => {
        request = value;
      }
    }
  };
  await clearSiteWipeDnrRules([1, 730000, 730000, 730499, 730500]);
  assert.deepEqual(request.removeRuleIds, [730000, 730499]);
});

test('request-shield recovery intent is persisted before the Chrome mutation', async () => {
  const { target, report } = targetAndReport();
  const events = [];
  let activeRules = [];
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        events.push('chrome-mutation');
        activeRules = activeRules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
      },
      getSessionRules: async () => activeRules
    }
  };

  const shield = await installTemporaryDnrShield(target, report, {
    onShieldPrepared: async (record) => {
      events.push(`persist-${record.lifecycle}`);
      assert.equal(record.lifecycle, 'installing');
    },
    onShieldInstalled: async (record) => events.push(`persist-${record.lifecycle}`),
    onShieldCleared: async () => events.push('persist-cleared')
  });
  assert.equal(shield.installed, true);
  assert.deepEqual(events.slice(0, 3), ['persist-installing', 'chrome-mutation', 'persist-active']);

  await finalizeTemporaryDnrShield(shield, report, {
    onShieldCleared: async () => events.push('persist-cleared')
  });
  assert.equal(activeRules.length, 0);
  assert.equal(events.at(-1), 'persist-cleared');
});

test('a timed-out install remains tracked until the complete owned range is proven empty', async () => {
  const { target, report } = targetAndReport();
  const lifecycle = [];
  let activeRules = [];
  let mutationCount = 0;
  let settleInstall;
  const pendingInstall = new Promise((resolve) => {
    settleInstall = resolve;
  });
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: ({ removeRuleIds = [], addRules = [] }) => {
        mutationCount += 1;
        if (mutationCount === 1) return pendingInstall;
        activeRules = activeRules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
        return Promise.resolve();
      },
      getSessionRules: async () => activeRules
    }
  };

  const shield = await installTemporaryDnrShield(target, report, {
    dnrTimeoutMs: 1,
    onShieldPrepared: async (record) => lifecycle.push(record.lifecycle),
    onShieldUncertain: async (record) => lifecycle.push(record.lifecycle),
    onShieldCleared: async () => lifecycle.push('cleared')
  });
  assert.equal(shield.installed, false);
  assert.equal(shield.uncertain, true);
  assert.deepEqual(lifecycle, ['installing', 'unknown']);

  await finalizeTemporaryDnrShield(shield, report, {
    dnrTimeoutMs: 20,
    dnrReconcileTimeoutMs: 1,
    onShieldCleared: async () => lifecycle.push('cleared')
  });
  assert.equal(report.summary.temporaryDnrShieldRemoved, true);
  assert.equal(lifecycle.at(-1), 'cleared');
  settleInstall();
});

test('DNR replace timeouts are explicit unknown outcomes, never ordinary failures', async () => {
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: () => new Promise(() => {})
    }
  };
  await assert.rejects(
    replaceSiteWipeDnrShieldRules([], { timeoutMs: 1 }),
    (error) => error?.name === 'OperationTimeoutError' && error?.operationMayContinue === true
  );
  assert.equal(SITEWIPE_DNR_RULE_IDS.length, 500);
});
