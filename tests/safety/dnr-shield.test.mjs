import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSiteInput } from '../../src/background/domain.js';
import { createReport } from '../../src/background/report.js';
import {
  buildTemporaryDnrShieldRules,
  clearSiteWipeDnrRules,
  finalizeTemporaryDnrShield,
  getSiteWipeDnrDiagnostics,
  hasPendingSiteWipeDnrMutation,
  installTemporaryDnrShield,
  replaceSiteWipeDnrShieldRules,
  SITEWIPE_DNR_RULE_IDS
} from '../../src/background/dnr-shield.js';
import { reconcileOwnedShieldState } from '../../src/background/shield-recovery.js';

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
    incognitoAccess: true,
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

test('final request-shield removal retains recovery when the DNR mutation API is unavailable', async () => {
  const { report } = targetAndReport();
  let cleared = false;
  let uncertainPatch = null;
  globalThis.chrome = {
    declarativeNetRequest: {
      getSessionRules: async () => []
    }
  };

  await finalizeTemporaryDnrShield(
    { installed: true, uncertain: false, ruleIds: [730000], keptAfterCleanup: false },
    report,
    {
      onShieldCleared: async () => {
        cleared = true;
      },
      onShieldUncertain: async (patch) => {
        uncertainPatch = patch;
      }
    }
  );

  assert.equal(report.summary.temporaryDnrShieldRemoved, false);
  assert.equal(cleared, false);
  assert.equal(uncertainPatch?.lifecycle, 'unknown');
  assert.equal(uncertainPatch?.pendingMutation, false);
  assert.match(report.errors.at(-1).message, /did not accept/i);
});

test('final request-shield removal retains recovery when empty-range diagnostics fail', async () => {
  const { report } = targetAndReport();
  let cleared = false;
  let uncertainPatch = null;
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: async () => {},
      getSessionRules: async () => {
        throw new Error('synthetic DNR diagnostic failure');
      }
    }
  };

  await finalizeTemporaryDnrShield(
    { installed: true, uncertain: false, ruleIds: [730000], keptAfterCleanup: false },
    report,
    {
      onShieldCleared: async () => {
        cleared = true;
      },
      onShieldUncertain: async (patch) => {
        uncertainPatch = patch;
      }
    }
  );

  assert.equal(report.summary.temporaryDnrShieldRemoved, false);
  assert.equal(cleared, false);
  assert.equal(uncertainPatch?.lifecycle, 'unknown');
  assert.equal(uncertainPatch?.pendingMutation, false);
  assert.match(report.errors.at(-1).message, /could not prove/i);
});

test('a timed-out install remains tracked until its late side effect is cleared after settlement', async () => {
  const { target, report } = targetAndReport();
  const lifecycle = [];
  let activeRecord = null;
  let activeRules = [];
  let mutationCount = 0;
  let settleInstall;
  let settleReaper;
  const reaperFinished = new Promise((resolve) => {
    settleReaper = resolve;
  });
  const pendingInstall = new Promise((resolve) => {
    settleInstall = resolve;
  });
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: ({ removeRuleIds = [], addRules = [] }) => {
        mutationCount += 1;
        if (mutationCount === 1) {
          return pendingInstall.then(() => {
            activeRules = activeRules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
          });
        }
        activeRules = activeRules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
        return Promise.resolve();
      },
      getSessionRules: async () => activeRules
    }
  };

  const reconcileLikeMaintenance = async () =>
    reconcileOwnedShieldState({
      activeShield: activeRecord,
      diagnose: () => getSiteWipeDnrDiagnostics(activeRecord),
      forget: async () => {
        activeRecord = null;
        lifecycle.push('cleared');
      },
      retain: async (record) => {
        activeRecord = record;
        return record;
      }
    });

  const shield = await installTemporaryDnrShield(target, report, {
    incognitoAccess: true,
    dnrTimeoutMs: 1,
    shieldJobId: 'timed-out-install-job',
    onShieldPrepared: async (record) => {
      activeRecord = record;
      lifecycle.push(record.lifecycle);
    },
    onShieldUncertain: async (record) => {
      activeRecord = { ...activeRecord, ...record };
      lifecycle.push(record.lifecycle);
    },
    onShieldCleared: async () => {
      activeRecord = null;
      lifecycle.push('cleared');
    },
    onShieldMutationSettled: async () => {
      activeRecord = { ...activeRecord, lifecycle: 'unknown', pendingMutation: false };
      await reconcileLikeMaintenance();
      settleReaper();
    }
  });
  assert.equal(shield.installed, false);
  assert.equal(shield.uncertain, true);
  assert.equal(hasPendingSiteWipeDnrMutation(), true);
  assert.deepEqual(lifecycle, ['installing', 'unknown']);

  await finalizeTemporaryDnrShield(shield, report, {
    dnrTimeoutMs: 20,
    dnrReconcileTimeoutMs: 1,
    onShieldUncertain: async (record) => lifecycle.push(record.lifecycle),
    onShieldCleared: async () => lifecycle.push('cleared')
  });
  assert.equal(report.summary.temporaryDnrShieldRemoved, false);
  assert.equal(report.sections.at(-1).details.operationSettlement, 'pending');
  assert.equal(report.sections.at(-1).details.pointInTimeRangeEmpty, true);
  assert.equal(report.sections.at(-1).details.recoveryRecordRetained, true);
  assert.equal(lifecycle.includes('cleared'), false);
  assert.equal(activeRecord.pendingMutation, true);
  assert.equal(mutationCount, 1, 'pending finalization must not start a second DNR mutation');
  assert.equal(hasPendingSiteWipeDnrMutation(), true);
  assert.notEqual(activeRecord, null, 'maintenance must retain durable recovery while the install can still settle');

  settleInstall();
  await pendingInstall;
  await reaperFinished;
  assert.equal(hasPendingSiteWipeDnrMutation(), false);
  assert.equal(activeRules.length, 0);
  assert.equal(activeRecord, null);
  assert.equal(lifecycle.at(-1), 'cleared');
  assert.equal(mutationCount, 2, 'the clear may start only after the original install has settled');
});

test('DNR replace timeouts are explicit unknown outcomes, never ordinary failures', async () => {
  let settleReplace;
  const pendingReplace = new Promise((resolve) => {
    settleReplace = resolve;
  });
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: () => pendingReplace
    }
  };
  await assert.rejects(
    replaceSiteWipeDnrShieldRules([], { timeoutMs: 1 }),
    (error) => error?.name === 'OperationTimeoutError' && error?.operationMayContinue === true
  );
  assert.equal(SITEWIPE_DNR_RULE_IDS.length, 500);
  settleReplace();
  await pendingReplace;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hasPendingSiteWipeDnrMutation(), false);
});

test('normal-only approval installs no shared DNR rule, including a requested post-wipe shield', async () => {
  const { target, report } = targetAndReport();
  let mutationCount = 0;
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: async () => {
        mutationCount += 1;
      }
    }
  };

  const shield = await installTemporaryDnrShield(target, report, {
    incognitoAccess: false,
    temporaryDnrShield: true,
    postWipeSessionBlock: true,
    onShieldPrepared: async () => assert.fail('normal-only cleanup must not persist DNR installation intent')
  });

  assert.equal(shield.installed, false);
  assert.equal(shield.skippedForNormalOnlyReview, true);
  assert.equal(mutationCount, 0);
  assert.equal(report.summary.temporaryDnrShieldSkippedForNormalOnlyReview, true);
  assert.match(report.sections.at(-1).details.reason, /cannot bind shared DNR session rules to normal windows only/i);
});

test('a timed-out clear must settle before a newer shield can reuse the owned rule IDs', async () => {
  const { target, report } = targetAndReport();
  let activeRules = [{ id: 730000, condition: { urlFilter: '||old.example^' } }];
  let settleOldClear;
  let mutationCount = 0;
  const oldClear = new Promise((resolve) => {
    settleOldClear = () => {
      activeRules = [];
      resolve();
    };
  });
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: ({ removeRuleIds = [], addRules = [] }) => {
        mutationCount += 1;
        if (mutationCount === 1) return oldClear;
        activeRules = activeRules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
        return Promise.resolve();
      },
      getSessionRules: async () => activeRules
    }
  };

  await assert.rejects(
    clearSiteWipeDnrRules(SITEWIPE_DNR_RULE_IDS, { timeoutMs: 1 }),
    (error) => error?.name === 'OperationTimeoutError' && error?.operationMayContinue === true
  );
  assert.equal(hasPendingSiteWipeDnrMutation(), true);

  const blocked = await installTemporaryDnrShield(target, report, {
    incognitoAccess: true,
    onShieldPrepared: async () => assert.fail('a newer shield must not be prepared while the old clear is pending')
  });
  assert.equal(blocked.blockedByPendingMutation, true);
  assert.equal(mutationCount, 1);

  settleOldClear();
  await oldClear;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hasPendingSiteWipeDnrMutation(), false);

  const newer = await installTemporaryDnrShield(target, report, {
    incognitoAccess: true,
    onShieldPrepared: async () => {},
    onShieldInstalled: async () => {}
  });
  assert.equal(newer.installed, true);
  assert.equal(activeRules.length, 1);
  assert.equal(activeRules[0].condition.urlFilter, '||example.com^');
});
