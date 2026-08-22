import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';

import {
  DIRECT_CLEANUP_CONTRACT_FILES,
  findDirectCleanupPublicationContractFindings
} from '../../scripts/direct-cleanup-publication-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testParser = new Linter({ configType: 'flat' });

test('publication contract accepts the owner-approved default-off preflight-bound direct design', async () => {
  const fixture = await currentFixture();
  assert.deepEqual(findDirectCleanupPublicationContractFindings(fixture), []);
});

test('publication contract rejects a default-on setting or incomplete owner decision', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/shared/constants.js'] = fixture.sources['src/shared/constants.js'].replace(
    'skipCleanupReview: false',
    'skipCleanupReview: true'
  );
  fixture.decision.defaultEnabled = true;
  const findings = findDirectCleanupPublicationContractFindings(fixture);
  assert.ok(findings.some((finding) => finding.includes('default-off')));
  assert.ok(findings.some((finding) => finding.includes('owner decision')));
});

test('publication contract rejects removal of explicit settings confirmation', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/options/options.js'] = fixture.sources['src/options/options.js'].replace(
    'control.checked && !confirmSkipCleanupReview()',
    'false'
  );
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('explicit Settings confirmation')
    )
  );
});

test('publication contract rejects a raw cleanup route that no longer consumes prepared authority first', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/background/service-worker.js'] = fixture.sources['src/background/service-worker.js'].replace(
    'consumeCleanupReviewRequest(payload',
    'consumeRemovedApproval(payload'
  );
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('consume prepared authority before runDeepClean')
    )
  );
});

test('publication contract rejects caller-controlled skip and raw cleanup-authority fields', async () => {
  const fixture = await currentFixture();
  const source = fixture.sources['src/shared/message-contracts.js'];
  const runRouteAt = source.indexOf('case MESSAGE_TYPES.runDeepClean:');
  const nextRouteAt = source.indexOf('case MESSAGE_TYPES.validateAssociatedGroups:', runRouteAt);
  const runRoute = source.slice(runRouteAt, nextRouteAt);
  const mutatedRunRoute = runRoute.replace(
    "              'popupPreparationCapability'\n            ]",
    [
      "              'popupPreparationCapability',",
      "              'skipCleanupReview',",
      "              'target',",
      "              'settings',",
      "              'approvedDownloadFileIds'",
      '            ]'
    ].join('\n')
  );
  assert.notEqual(mutatedRunRoute, runRoute, 'the external runDeepClean allowlist fixture must be changed');
  fixture.sources['src/shared/message-contracts.js'] =
    source.slice(0, runRouteAt) + mutatedRunRoute + source.slice(nextRouteAt);

  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('only prepared approval/context fields plus required worker-minted popup binding credentials')
    )
  );
});

test('publication contract rejects an optional, caller-created, or raw-persisted popup binding', async () => {
  const fixture = await currentFixture();
  const messageContractBefore = fixture.sources['src/shared/message-contracts.js'];
  fixture.sources['src/shared/message-contracts.js'] = messageContractBefore.replace(
    'if (validationOptions.allowInternalArmedCleanup !== true) assertPopupPreparationBinding(payload);',
    'void validationOptions;'
  );
  assert.notEqual(fixture.sources['src/shared/message-contracts.js'], messageContractBefore);

  const preflightBefore = fixture.sources['src/background/cleanup-preflight.js'];
  fixture.sources['src/background/cleanup-preflight.js'] = preflightBefore
    .replace('const bytes = new Uint8Array(32);', 'const bytes = new Uint8Array(16);')
    .replace(
      '    popupPreparationCapabilityDigest,\n    incognitoAccess,',
      '    popupPreparationCapabilityDigest,\n    popupPreparationCapability: dependencies.popupPreparationCapability,\n    incognitoAccess,'
    );
  assert.notEqual(fixture.sources['src/background/cleanup-preflight.js'], preflightBefore);

  const workerBefore = fixture.sources['src/background/service-worker.js'];
  fixture.sources['src/background/service-worker.js'] = workerBefore.replace(
    'requirePopupPreparationCapability: !trustedInternalArmedCleanup',
    'requirePopupPreparationCapability: false'
  );
  assert.notEqual(fixture.sources['src/background/service-worker.js'], workerBefore);

  const stateSchemaBefore = fixture.sources['src/shared/state-schema.js'];
  fixture.sources['src/shared/state-schema.js'] = stateSchemaBefore.replace(
    '    output.popupPreparationCapabilityDigest = value.popupPreparationCapabilityDigest;',
    '    output.popupPreparationCapabilityDigest = value.popupPreparationCapabilityDigest;\n    output.popupPreparationCapability = value.popupPreparationCapability;'
  );
  assert.notEqual(fixture.sources['src/shared/state-schema.js'], stateSchemaBefore);

  const findings = findDirectCleanupPublicationContractFindings(fixture);
  assert.ok(
    findings.some((finding) =>
      finding.includes('only prepared approval/context fields plus required worker-minted popup binding credentials')
    )
  );
  assert.ok(findings.some((finding) => finding.includes('256 bits of randomness')));
  assert.ok(findings.some((finding) => finding.includes('again at atomic approval consumption')));
  assert.ok(findings.some((finding) => finding.includes('raw popup preparation capability must never be persisted')));
});

test('publication contract rejects untruthful direct report evidence', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/background/cleanup-authorization.js'] = fixture.sources[
    'src/background/cleanup-authorization.js'
  ].replace('report.summary.scopeReviewApproved = usedDetailedReview;', 'report.summary.scopeReviewApproved = true;');
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('scopeReviewApproved = usedDetailedReview')
    )
  );
});

test('publication contract preserves the private-source and pending installed-evidence limits', async () => {
  const fixture = await currentFixture();
  fixture.decision.incognitoRequirements.privateSourceRequiresPreexistingExactTargetAccess = false;
  fixture.decision.installedBrowserEvidence = 'passed';
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('pending installed-evidence state')
    )
  );
});

test('publication contract catches semantic popup-binding safety mutations', async (t) => {
  const baseline = await currentFixture();
  const cases = [
    {
      name: 'permissive assertKeys helper',
      path: 'src/shared/message-contracts.js',
      mutate: (source) => replaceNamedFunctionBody(source, 'assertKeys', '{ void value; void allowedKeys; }'),
      finding: 'assertKeys must reject every unknown own payload key'
    },
    {
      name: 'no-op exact-popup sender helper',
      path: 'src/background/service-worker.js',
      mutate: (source) => replaceNamedFunctionBody(source, 'assertExactPopupSender', '{ void sender; void action; }'),
      finding: 'assertExactPopupSender must actively reject'
    },
    {
      name: 'Chrome action-popup sentinel guard restored to the incompatible negative-id rejection',
      path: 'src/background/service-worker.js',
      mutate: (source) => source.replace('context?.windowId !== -1 ||', 'context?.windowId < 0 ||'),
      finding: 'runtime.getContexts popup validation must require Chrome action-popup sentinel ids'
    },
    {
      name: 'cleanup preparation falls back to optional sender documentId',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          'const popupContext = await inspectExactPreparingPopupContext();',
          'const popupContext = { contextId: sender.documentId };'
        ),
      finding: 'cleanup preparation must bind only the worker-resolved popup contextId'
    },
    {
      name: 'popup context query drops the exact POPUP type filter',
      path: 'src/background/service-worker.js',
      mutate: (source) => source.replace("        contextTypes: ['POPUP'],\n", ''),
      finding: 'popup inspection must query exactly one exact-URL POPUP context'
    },
    {
      name: 'popup context query accepts more than one exact match',
      path: 'src/background/service-worker.js',
      mutate: (source) => source.replace('  if (contexts.length !== 1) {', '  if (contexts.length < 1) {'),
      finding: 'popup inspection must query exactly one exact-URL POPUP context'
    },
    {
      name: 'popup context query returns an unvalidated context id',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          '  return validateRuntimePopupContext(contexts[0]);',
          '  return { contextId: contexts[0].contextId };'
        ),
      finding: 'popup inspection must query exactly one exact-URL POPUP context'
    },
    {
      name: 'popup context liveness skips complete context revalidation',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          '  validateRuntimePopupContext(contexts[0], { expectedContextId: normalizedContextId });',
          '  void contexts[0];'
        ),
      finding: 'popup-context liveness must query the exact contextId'
    },
    {
      name: 'no-op popup binding helper',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNamedFunctionBody(
          source,
          'assertCleanupReviewPopupBinding',
          '{ void record; void payload; return true; }'
        ),
      finding: 'assertCleanupReviewPopupBinding must compare exact context'
    },
    {
      name: 'deterministic zero-filled capability',
      path: 'src/background/cleanup-preflight.js',
      mutate: replaceCryptoCapabilityFillWithZeros,
      finding: 'filled by crypto.getRandomValues before encoding'
    },
    {
      name: 'raw worker-minted capability persisted by preflight',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'await storageLocal.set({ leakedPopupCapability: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'raw popup capability persisted from popup memory',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        insertAfterPopupBindingSet(
          source,
          'void chrome.storage.local.set({ leakedPopupCapability: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'payload-selectable internal continuation through Reflect.get alias',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        addCallerPayloadBypass(
          source,
          "const callerPayload = Reflect.get(message || {}, 'pay' + 'load') || {};",
          "callerPayload.approval?.approvalMode === 'settings_direct' && sender?.id === chrome.runtime.id"
        ),
      finding: 'internal armed cleanup selection must be an exact worker-only conjunction'
    },
    {
      name: 'payload-selectable internal continuation through computed destructuring',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        addCallerPayloadBypass(
          source,
          "const { ['pay' + 'load']: callerPayload = {} } = message || {};",
          "callerPayload.approval?.approvalMode === 'settings_direct' && sender?.id === chrome.runtime.id"
        ),
      finding: 'internal armed cleanup selection must be an exact worker-only conjunction'
    },
    {
      name: 'dead pre-reservation popup check',
      path: 'src/background/service-worker.js',
      mutate: disableExternalPopupGuard,
      finding: 'external popup checks must be live, dominate cleanup reservation'
    },
    {
      name: 'disabled consume recheck with a dead safe marker',
      path: 'src/background/service-worker.js',
      mutate: disableCapabilityConsumeRecheck,
      finding: 'external popup checks must be live, dominate cleanup reservation'
    },
    {
      name: 'raw capability sent to a computed diagnostic sink',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        insertIntoRunDeepCleanRoute(
          source,
          "console['de' + 'bug']({ leakedPopupCapability: payload['popup' + 'PreparationCapability'] });"
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'computed destructured popup capability persisted through an alias',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        insertAfterPopupBindingSet(
          source,
          "const { ['popup' + 'PreparationCapability']: rawAlias } = response;\n  void chrome.storage.local.set({ rawAlias });"
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'Reflect.get popup capability persisted through an alias',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        insertAfterPopupBindingSet(
          source,
          "const rawAlias = Reflect.get(response, 'popup' + 'PreparationCapability');\n  void chrome.storage.local.set({ rawAlias });"
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'raw capability object container persisted by preflight',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'const leakContainer = { value: popupPreparationCapability };\n  await storageLocal.set(leakContainer);'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'raw capability passed through a bound storage sink alias',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'const persistRaw = storageLocal.set.bind(storageLocal);\n  await persistRaw({ value: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'exact sender rejection weakened from OR to AND',
      path: 'src/background/service-worker.js',
      mutate: weakenExactSenderFirstDisjunction,
      finding: 'assertExactPopupSender must actively reject'
    },
    {
      name: 'popup context rejection weakened from OR to AND',
      path: 'src/background/cleanup-preflight.js',
      mutate: weakenPopupBindingContextDisjunction,
      finding: 'assertCleanupReviewPopupBinding must compare exact context'
    },
    {
      name: 'constant-time digest difference reset after comparison loop',
      path: 'src/background/cleanup-preflight.js',
      mutate: resetDigestDifferenceAfterLoop,
      finding: 'assertCleanupReviewPopupBinding must compare exact context'
    },
    {
      name: 'cryptographically filled capability replaced at return',
      path: 'src/background/cleanup-preflight.js',
      mutate: returnDeterministicCapabilityAfterCryptoFill,
      finding: 'filled by crypto.getRandomValues before encoding'
    },
    {
      name: 'runDeepClean message allowlist bypassed by an early return',
      path: 'src/shared/message-contracts.js',
      mutate: insertRunDeepCleanContractEarlyReturn,
      finding: 'runDeepClean must actively enforce its exact external/internal allowlists'
    },
    {
      name: 'assertKeys bypassed by an early return',
      path: 'src/shared/message-contracts.js',
      mutate: (source) => insertAtNamedFunctionStart(source, 'assertKeys', 'if (value.approvalToken) return;'),
      finding: 'assertKeys must reject every unknown own payload key'
    },
    {
      name: 'popup binding bypassed by a forged-capability early success',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertAtNamedFunctionStart(
          source,
          'assertCleanupReviewPopupBinding',
          "if (payload.popupPreparationCapability === '0'.repeat(64)) return true;"
        ),
      finding: 'assertCleanupReviewPopupBinding must compare exact context'
    },
    {
      name: 'message envelope disconnects active payload validation',
      path: 'src/shared/message-contracts.js',
      mutate: disableEnvelopePayloadValidation,
      finding: 'runDeepClean must actively enforce its exact external/internal allowlists'
    },
    {
      name: 'trusted internal assignment becomes caller-payload selectable',
      path: 'src/background/service-worker.js',
      mutate: makeTrustedInternalAssignmentPayloadSelectable,
      finding: 'internal armed cleanup selection must be an exact worker-only conjunction'
    },
    {
      name: 'message envelope hardcodes the internal validation exception',
      path: 'src/background/service-worker.js',
      mutate: hardcodeInternalEnvelopeValidation,
      finding: 'internal armed cleanup selection must be an exact worker-only conjunction'
    },
    {
      name: 'atomic consume reverses the required capability condition',
      path: 'src/background/cleanup-preflight.js',
      mutate: reverseConsumeCapabilityGuard,
      finding: 'atomic cleanup consumption must enforce popup binding'
    },
    {
      name: 'capability digest helper returns one constant digest',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNamedFunctionBody(
          source,
          'digestCleanupPopupPreparationCapability',
          "{ void value; return '0'.repeat(64); }"
        ),
      finding: 'must be validated and reduced only through SHA-256'
    },
    {
      name: 'popup context normalizer collapses all contexts',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNamedFunctionBody(source, 'normalizePopupContextId', "{ void value; return 'shared-popup-context'; }"),
      finding: 'must preserve the exact opaque nonempty Chrome context ID'
    },
    {
      name: 'capability digest helper returns the raw capability',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNamedFunctionBody(source, 'digestCleanupPopupPreparationCapability', '{ return String(value); }'),
      finding: 'must be validated and reduced only through SHA-256'
    },
    {
      name: 'runDeepClean skips binding validation after its allowlist',
      path: 'src/shared/message-contracts.js',
      mutate: insertRunDeepCleanPostAllowlistEarlyReturn,
      finding: 'runDeepClean must actively enforce its exact external/internal allowlists'
    },
    {
      name: 'validatePayload bypasses the runDeepClean switch case',
      path: 'src/shared/message-contracts.js',
      mutate: (source) =>
        insertAtNamedFunctionStart(source, 'validatePayload', 'if (type === MESSAGE_TYPES.runDeepClean) return;'),
      finding: 'runDeepClean must actively enforce its exact external/internal allowlists'
    },
    {
      name: 'message validation failure helper becomes a no-op',
      path: 'src/shared/message-contracts.js',
      mutate: (source) => replaceNamedFunctionBody(source, 'fail', '{ void message; }'),
      finding: 'assertKeys must reject every unknown own payload key'
    },
    {
      name: 'raw capability persisted through a one-hop arrow wrapper',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'const persistRaw = (value) => storageLocal.set(value);\n  await persistRaw({ value: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'raw capability persisted through a one-hop declared wrapper',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'function persistRaw(value) { return storageLocal.set(value); }\n  await persistRaw({ value: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    }
  ];

  for (const mutation of cases) {
    await t.test(mutation.name, () => {
      const fixture = {
        sources: { ...baseline.sources },
        decision: structuredClone(baseline.decision)
      };
      const before = fixture.sources[mutation.path];
      const after = mutation.mutate(before);
      assert.notEqual(after, before, `${mutation.name} must alter its fixture structurally`);
      fixture.sources[mutation.path] = after;
      const findings = findDirectCleanupPublicationContractFindings(fixture);
      assert.ok(
        findings.some((finding) => finding.includes(mutation.finding)),
        `${mutation.name} must be detected; findings were:\n${findings.join('\n')}`
      );
    });
  }
});

async function currentFixture() {
  const sources = Object.fromEntries(
    await Promise.all(
      DIRECT_CLEANUP_CONTRACT_FILES.map(async (path) => [path, await readFile(resolve(root, path), 'utf8')])
    )
  );
  const decision = JSON.parse(
    await readFile(resolve(root, 'docs/decisions/direct-cleanup-owner-decision.json'), 'utf8')
  );
  return { sources, decision };
}

function parseSource(source) {
  let ast = null;
  const captureAstRule = {
    create() {
      return {
        Program(node) {
          ast = node;
        }
      };
    }
  };
  const messages = testParser.verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { mutation: { rules: { 'capture-ast': captureAstRule } } },
    rules: { 'mutation/capture-ast': 'error' }
  });
  assert.ok(ast && !messages.some((message) => message.fatal), 'mutation fixture must parse');
  return ast;
}

function replaceNamedFunctionBody(source, name, replacement) {
  const functionNode = findNode(
    parseSource(source),
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === name
  );
  assert.ok(functionNode?.body, `${name} fixture function must exist`);
  return replaceRanges(source, [[functionNode.body.start, functionNode.body.end, replacement]]);
}

function replaceCryptoCapabilityFillWithZeros(source) {
  const functionNode = findNamedFunction(source, 'randomPopupPreparationCapability');
  const call = findNode(
    functionNode,
    (node) => node.type === 'CallExpression' && memberPath(node.callee) === 'globalThis.crypto.getRandomValues'
  );
  assert.ok(call, 'capability crypto-fill fixture call must exist');
  return replaceRanges(source, [[call.start, call.end, 'bytes.fill(0)']]);
}

function insertBeforeRawCapabilityReturn(source, statement) {
  const functionNode = findNamedFunction(source, 'prepareCleanupReviewRequest');
  const returnNode = findNode(
    functionNode.body,
    (node) =>
      node.type === 'ReturnStatement' &&
      node.argument?.type === 'ObjectExpression' &&
      node.argument.properties.some(
        (property) => property.type === 'Property' && propertyName(property.key) === 'popupPreparationCapability'
      )
  );
  assert.ok(returnNode, 'prepare response carrying the transient raw capability must exist');
  return replaceRanges(source, [[returnNode.start, returnNode.start, `${statement}\n  `]]);
}

function insertAfterPopupBindingSet(source, statement) {
  const ast = parseSource(source);
  const expressionStatement = findNode(
    ast,
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'CallExpression' &&
      memberPath(node.expression.callee) === 'popupPreparationBindings.set'
  );
  assert.ok(expressionStatement, 'popup in-memory binding fixture call must exist');
  return replaceRanges(source, [[expressionStatement.end, expressionStatement.end, `\n  ${statement}`]]);
}

function addCallerPayloadBypass(source, declaration, bypassExpression) {
  const functionNode = findNamedFunction(source, 'isTrustedInternalArmedCleanup');
  const returnNode = functionNode.body.body.find((statement) => statement.type === 'ReturnStatement');
  const booleanCall = returnNode?.argument;
  assert.equal(booleanCall?.type, 'CallExpression');
  assert.equal(memberPath(booleanCall.callee), 'Boolean');
  const originalAuthority = source.slice(booleanCall.arguments[0].start, booleanCall.arguments[0].end);
  return replaceRanges(source, [
    [returnNode.start, returnNode.start, `${declaration}\n  `],
    [booleanCall.arguments[0].start, booleanCall.arguments[0].end, `(${originalAuthority}) || (${bypassExpression})`]
  ]);
}

function disableExternalPopupGuard(source) {
  const runCase = findRunDeepCleanCase(source);
  const guard = findNode(
    runCase,
    (node) =>
      node.type === 'IfStatement' &&
      node.test?.type === 'UnaryExpression' &&
      node.test.operator === '!' &&
      node.test.argument?.name === 'trustedInternalArmedCleanup'
  );
  assert.ok(guard, 'external popup guard fixture must exist');
  const original = source.slice(guard.test.start, guard.test.end);
  return replaceRanges(source, [[guard.test.start, guard.test.end, `false && (${original})`]]);
}

function disableCapabilityConsumeRecheck(source) {
  const runCase = findRunDeepCleanCase(source);
  const consumeCall = findNode(
    runCase,
    (node) => node.type === 'CallExpression' && memberPath(node.callee) === 'consumeCleanupReviewRequest'
  );
  const options = consumeCall?.arguments?.[1];
  const property = options?.properties?.find(
    (candidate) => candidate.type === 'Property' && propertyName(candidate.key) === 'requirePopupPreparationCapability'
  );
  assert.ok(property, 'atomic capability recheck fixture property must exist');
  const originalValue = source.slice(property.value.start, property.value.end);
  const replacement = [
    'requirePopupPreparationCapability: false,',
    `...(false ? { requirePopupPreparationCapability: ${originalValue} } : {})`
  ].join(' ');
  return replaceRanges(source, [[property.start, property.end, replacement]]);
}

function insertIntoRunDeepCleanRoute(source, statement) {
  const runCase = findRunDeepCleanCase(source);
  const block = runCase.consequent.find((node) => node.type === 'BlockStatement');
  assert.ok(block, 'runDeepClean route block fixture must exist');
  return replaceRanges(source, [[block.start + 1, block.start + 1, `\n      ${statement}`]]);
}

function weakenExactSenderFirstDisjunction(source) {
  const functionNode = findNamedFunction(source, 'assertExactPopupSender');
  const guard = findNode(
    functionNode.body,
    (node) => node.type === 'IfStatement' && source.slice(node.test.start, node.test.end).includes('sender?.id')
  );
  assert.ok(guard, 'exact-popup sender rejection guard must exist');
  const operatorAt = source.indexOf('||', guard.test.start);
  assert.ok(operatorAt >= guard.test.start && operatorAt < guard.test.end, 'sender rejection disjunction must exist');
  return replaceRanges(source, [[operatorAt, operatorAt + 2, '&&']]);
}

function weakenPopupBindingContextDisjunction(source) {
  const functionNode = findNamedFunction(source, 'assertCleanupReviewPopupBinding');
  const guard = findNode(
    functionNode.body,
    (node) =>
      node.type === 'IfStatement' &&
      source.slice(node.test.start, node.test.end).includes('popupContextId !== record.preparationContextId')
  );
  const finalDisjunction = findNode(
    guard?.test,
    (node) =>
      node.type === 'LogicalExpression' &&
      node.operator === '||' &&
      node.right?.type === 'UnaryExpression' &&
      node.right.operator === '!' &&
      node.right.argument?.name === 'expectedDigest'
  );
  assert.ok(finalDisjunction, 'popup binding context disjunction must exist');
  const between = source.slice(finalDisjunction.left.end, finalDisjunction.right.start);
  assert.match(between, /\|\|/);
  return replaceRanges(source, [
    [finalDisjunction.left.end, finalDisjunction.right.start, between.replace('||', '&&')]
  ]);
}

function resetDigestDifferenceAfterLoop(source) {
  const functionNode = findNamedFunction(source, 'assertCleanupReviewPopupBinding');
  const loop = findNode(functionNode.body, (node) => node.type === 'ForStatement');
  assert.ok(loop, 'constant-time digest loop must exist');
  return replaceRanges(source, [[loop.end, loop.end, '\n  difference = 0;']]);
}

function returnDeterministicCapabilityAfterCryptoFill(source) {
  const functionNode = findNamedFunction(source, 'randomPopupPreparationCapability');
  const returnNode = findNode(functionNode.body, (node) => node.type === 'ReturnStatement');
  assert.ok(returnNode?.argument, 'capability encoding return must exist');
  const original = source.slice(returnNode.argument.start, returnNode.argument.end);
  return replaceRanges(source, [
    [returnNode.argument.start, returnNode.argument.end, `bytes.length === -1 ? (${original}) : '0'.repeat(64)`]
  ]);
}

function insertRunDeepCleanContractEarlyReturn(source) {
  const runCase = findRunDeepCleanCase(source);
  const firstStatement = runCase.consequent[0];
  assert.ok(firstStatement, 'runDeepClean message contract must contain validation statements');
  return replaceRanges(source, [
    [firstStatement.start, firstStatement.start, 'if (payload.approvalToken) return;\n      ']
  ]);
}

function insertRunDeepCleanPostAllowlistEarlyReturn(source) {
  const runCase = findRunDeepCleanCase(source);
  const assertKeysStatement = runCase.consequent[0];
  assert.ok(assertKeysStatement, 'runDeepClean allowlist statement must exist');
  return replaceRanges(source, [
    [assertKeysStatement.end, assertKeysStatement.end, '\n      if (payload.approvalToken) return;']
  ]);
}

function disableEnvelopePayloadValidation(source) {
  const functionNode = findNamedFunction(source, 'validateMessageEnvelope');
  const validationStatement = functionNode.body.body.find(
    (statement) =>
      statement.type === 'ExpressionStatement' &&
      statement.expression?.type === 'CallExpression' &&
      memberPath(statement.expression.callee) === 'validatePayload'
  );
  assert.ok(validationStatement, 'active envelope payload validation call must exist');
  return replaceRanges(source, [[validationStatement.start, validationStatement.end, 'void validationOptions;']]);
}

function makeTrustedInternalAssignmentPayloadSelectable(source) {
  const functionNode = findNamedFunction(source, 'handleMessage');
  const declaration = findNode(
    functionNode.body,
    (node) => node.type === 'VariableDeclarator' && node.id?.name === 'trustedInternalArmedCleanup'
  );
  assert.ok(declaration?.init, 'trusted internal cleanup assignment must exist');
  const original = source.slice(declaration.init.start, declaration.init.end);
  return replaceRanges(source, [
    [
      declaration.init.start,
      declaration.init.end,
      `${original} || message?.payload?.approval?.approvalMode === 'settings_direct'`
    ]
  ]);
}

function hardcodeInternalEnvelopeValidation(source) {
  const functionNode = findNamedFunction(source, 'handleMessage');
  const envelope = findNode(
    functionNode.body,
    (node) => node.type === 'VariableDeclarator' && node.id?.name === 'envelope'
  );
  const options = envelope?.init?.arguments?.[3];
  const property = options?.properties?.find(
    (candidate) => candidate.type === 'Property' && propertyName(candidate.key) === 'allowInternalArmedCleanup'
  );
  assert.ok(property?.value, 'envelope internal-validation option must exist');
  return replaceRanges(source, [[property.value.start, property.value.end, 'true']]);
}

function reverseConsumeCapabilityGuard(source) {
  const functionNode = findNamedFunction(source, 'consumeCleanupReviewRequest');
  const guard = findNode(
    functionNode.body,
    (node) =>
      node.type === 'IfStatement' &&
      node.test?.type === 'BinaryExpression' &&
      memberPath(node.test.left) === 'dependencies.requirePopupPreparationCapability'
  );
  assert.equal(guard?.test?.right?.value, true, 'atomic consume capability guard must require true');
  return replaceRanges(source, [[guard.test.right.start, guard.test.right.end, 'false']]);
}

function insertAtNamedFunctionStart(source, name, statement) {
  const functionNode = findNamedFunction(source, name);
  return replaceRanges(source, [[functionNode.body.start + 1, functionNode.body.start + 1, `\n  ${statement}`]]);
}

function findNamedFunction(source, name) {
  const functionNode = findNode(
    parseSource(source),
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === name
  );
  assert.ok(functionNode, `${name} fixture function must exist`);
  return functionNode;
}

function findRunDeepCleanCase(source) {
  const runCase = findNode(
    parseSource(source),
    (node) => node.type === 'SwitchCase' && memberPath(node.test) === 'MESSAGE_TYPES.runDeepClean'
  );
  assert.ok(runCase, 'runDeepClean route fixture must exist');
  return runCase;
}

function replaceRanges(source, replacements) {
  let result = source;
  for (const [start, end, value] of [...replacements].sort((left, right) => right[0] - left[0])) {
    result = result.slice(0, start) + value + result.slice(end);
  }
  return result;
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.type === 'string' && predicate(node)) return node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'range' || key === 'parent' || key === 'comments' || key === 'tokens') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findNode(child, predicate);
        if (found) return found;
      }
    } else {
      const found = findNode(value, predicate);
      if (found) return found;
    }
  }
  return null;
}

function memberPath(node) {
  if (!node) return '';
  if (node.type === 'ChainExpression') return memberPath(node.expression);
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression') return '';
  const object = memberPath(node.object);
  const property = propertyName(node.property);
  return object && property ? `${object}.${property}` : '';
}

function propertyName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal') return String(node.value);
  return '';
}
