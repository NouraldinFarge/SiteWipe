import { Linter } from 'eslint';

const publicationContractParser = new Linter({ configType: 'flat' });

export const DIRECT_CLEANUP_OWNER_AMENDMENT_FINDING =
  'docs/decisions/direct-cleanup-owner-decision.json: the exact owner amendment for the one-activation pregranted and two-activation missing-access source-candidate contract is incomplete or stale';

export const DIRECT_CLEANUP_CONTRACT_FILES = Object.freeze([
  'src/background/cleanup-authorization.js',
  'src/background/cleanup-preflight.js',
  'src/background/permission-leases.js',
  'src/background/service-worker.js',
  'src/handoff/handoff.js',
  'src/options/options.html',
  'src/options/options.js',
  'src/popup/popup.js',
  'src/shared/cleanup-review.js',
  'src/shared/constants.js',
  'src/shared/message-contracts.js',
  'src/shared/messaging.js',
  'src/shared/state-schema.js',
  'src/shared/settings-backup.js'
]);

const EXTERNAL_RUN_DEEP_CLEAN_FIELDS = Object.freeze([
  'approvalToken',
  'approval',
  'sourceWindowId',
  'sourceIncognito',
  'popupContextId',
  'popupPreparationCapability'
]);
const INTERNAL_ARMED_CLEANUP_FIELDS = Object.freeze(['approvalToken', 'approval', 'sourceWindowId', 'sourceIncognito']);
const FORBIDDEN_CALLER_AUTHORITY_FIELDS = Object.freeze([
  'skipCleanupReview',
  'skipReview',
  'bypass',
  'target',
  'settings',
  'requirements',
  'impact',
  'approvedDownloadFileIds',
  'hostPermissionsGranted',
  'temporaryHostPermissionOrigins',
  'permissionLeaseId'
]);

/**
 * Static release defense for the owner-approved optional direct-cleanup design.
 * Behavioral tests remain authoritative for execution semantics; this check
 * prevents a publication run from silently dropping its essential source and
 * owner-decision markers.
 */
export function findDirectCleanupPublicationContractFindings({ sources = {}, decision = null, version = null } = {}) {
  const findings = [];
  const requireSource = (path) => {
    const value = sources[path];
    if (typeof value !== 'string') {
      findings.push(`${path}: source unavailable`);
      return '';
    }
    return value;
  };
  const requirePattern = (path, pattern, finding) => {
    const source = requireSource(path);
    if (source && !pattern.test(source)) findings.push(`${path}: ${finding}`);
  };

  validateOwnerDecision(decision, findings, version);

  requirePattern('src/shared/constants.js', /skipCleanupReview:\s*false/, 'skipCleanupReview must remain default-off');
  requirePattern(
    'src/options/options.html',
    /id=["']skipCleanupReview["']/,
    'the direct-cleanup setting must remain present'
  );
  requirePattern(
    'src/options/options.html',
    /Off by default[\s\S]*(?:Standard|Expert)[\s\S]*(?:permission prompt|downloaded-file deletion|incognito)/i,
    'the direct-cleanup default and risk warning copy must remain present'
  );
  requirePattern(
    'src/options/options.js',
    /control\.checked\s*&&\s*!confirmSkipCleanupReview\(\)/,
    'enabling direct cleanup must require the explicit Settings confirmation'
  );
  requirePattern(
    'src/options/options.js',
    /function\s+confirmSkipCleanupReview\([\s\S]*globalThis\.confirm\(/,
    'the direct-cleanup confirmation must use an explicit user decision'
  );
  requirePattern(
    'src/shared/constants.js',
    /storagePartitionDisclosureAppliedAt:\s*null/,
    'the selected-site storage disclosure migration marker must remain default-unapplied'
  );
  requirePattern(
    'src/background/service-worker.js',
    /if\s*\(needsStoragePartitionDisclosure\)[\s\S]{0,180}skipCleanupReview:\s*false[\s\S]{0,120}storagePartitionDisclosureAppliedAt:\s*now/,
    'worker-load migration must disable an older direct-cleanup opt-in before recording the selected-site storage disclosure marker'
  );
  requirePattern(
    'src/background/service-worker.js',
    /if\s*\(!settings\.storagePartitionDisclosureAppliedAt\)[\s\S]{0,180}skipCleanupReview:\s*false[\s\S]{0,120}storagePartitionDisclosureAppliedAt:\s*now/,
    'install/update migration must disable an older direct-cleanup opt-in before recording the selected-site storage disclosure marker'
  );
  requirePattern(
    'src/shared/settings-backup.js',
    /settings\.skipCleanupReview\s*===\s*true[\s\S]{0,300}Skip detailed cleanup review completely/i,
    'settings import must recognize the direct-cleanup authorization risk'
  );

  requirePattern(
    'src/shared/cleanup-review.js',
    /settings\.skipCleanupReview\s*===\s*true[\s\S]{0,160}CLEANUP_APPROVAL_MODES\.settingsDirect/,
    'settings_direct must be derived from strict current stored settings'
  );
  requirePattern(
    'src/shared/cleanup-review.js',
    /approvalMode\s*===\s*CLEANUP_APPROVAL_MODES\.settingsDirect[\s\S]*reviewedScope[\s\S]*fileConfirmationText/,
    'direct approval must reject synthetic per-run acknowledgements and file phrases'
  );
  requirePattern(
    'src/background/cleanup-preflight.js',
    /record\.approvalMode\s*===\s*['"]settings_direct['"][\s\S]*record\.settings\.skipCleanupReview\s*!==\s*true[\s\S]*currentScope\.settings\.skipCleanupReview\s*!==\s*true/,
    'token consumption must revalidate the direct setting in prepared and current settings'
  );
  for (const marker of ['reviewSnapshot', 'approvedDownloadFileIds', 'permissionLeaseId']) {
    requirePattern(
      'src/background/cleanup-preflight.js',
      new RegExp(`\\b${marker}\\b`),
      `the prepared record must bind ${marker}`
    );
  }
  requirePattern(
    'src/background/permission-leases.js',
    /PERMISSION_PROMPT_PENDING_TTL_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/,
    'prompt-pending access recovery must retain its conservative 30-minute window'
  );
  requirePattern(
    'src/background/permission-leases.js',
    /prompt_pending/,
    'the durable permission lease must represent prompt-pending ownership'
  );

  requirePattern(
    'src/popup/popup.js',
    /prepareDirectCleanup[\s\S]*MESSAGE_TYPES\.prepareCleanupReview/,
    'direct cleanup must prepare through the ordinary read-only preflight route'
  );
  requirePattern(
    'src/popup/popup.js',
    /deepCleanButton[^\n]*disabled\s*=\s*directCleanupEnabled\(\)[\s\S]{0,180}directPreparationPending\s*\|\|\s*!directCleanupReview/,
    'Clean now must remain disabled until hidden preflight preparation completes'
  );
  requirePattern(
    'src/popup/popup.js',
    /approvalMode:\s*['"]settings_direct['"][\s\S]{0,220}reviewedScope:\s*false[\s\S]{0,260}fileConfirmationText:\s*['"]["']/,
    'the popup must submit truthful direct-mode acknowledgement fields'
  );
  requirePattern(
    'src/popup/popup.js',
    /const\s+popupPreparationBindings\s*=\s*new\s+Map\(\)[\s\S]*popupPreparationBindings\.set\([\s\S]{0,220}popupContextId[\s\S]{0,120}popupPreparationCapability/,
    'the worker-minted popup binding must remain transient in popup memory'
  );
  requirePattern(
    'src/popup/popup.js',
    /sendMessage\(MESSAGE_TYPES\.runDeepClean,[\s\S]{0,260}requirePopupPreparationBinding\(review\)/,
    'external runDeepClean must submit the exact prepared popup binding'
  );

  const popupSource = requireSource('src/popup/popup.js');
  if (popupSource) {
    validatePopupPermissionActivationContract(popupSource, requireSource('src/handoff/handoff.js'), findings);
    validateReplacementPopupRecoveryLock(popupSource, findings);
  }
  validateDurableArmAcknowledgement(requireSource('src/background/cleanup-preflight.js'), findings);

  const messageContractSource = requireSource('src/shared/message-contracts.js');
  if (messageContractSource) {
    validateRunDeepCleanMessageContract(messageContractSource, findings);
    validateBeginCleanupPermissionPromptMessageContract(messageContractSource, findings);
  }
  requirePattern(
    'src/shared/message-contracts.js',
    /\[['"]detailed_review['"],\s*['"]settings_direct['"]\]\.includes\(value\.approvalMode\)/,
    'only detailed_review and settings_direct may cross the message boundary'
  );

  requirePattern(
    'src/background/cleanup-preflight.js',
    /createPopupPreparationCapability\s*=\s*randomPopupPreparationCapability/,
    'the popup preparation capability must be worker-minted'
  );
  requirePattern(
    'src/background/cleanup-preflight.js',
    /function\s+randomPopupPreparationCapability\(\)[\s\S]{0,180}new\s+Uint8Array\(32\)/,
    'the popup preparation capability must retain 256 bits of randomness'
  );
  requirePattern(
    'src/background/cleanup-preflight.js',
    /popupPreparationCapabilityDigest\s*=\s*await\s+digestCleanupPopupPreparationCapability\(popupPreparationCapability\)/,
    'the raw popup preparation capability must be reduced to a digest before storage'
  );
  validateTransientPopupCapabilityPersistence(
    requireSource('src/background/cleanup-preflight.js'),
    requireSource('src/shared/state-schema.js'),
    findings
  );
  requirePattern(
    'src/shared/messaging.js',
    /type\s*===\s*MESSAGE_TYPES\.runDeepClean\s*\|\|\s*type\s*===\s*MESSAGE_TYPES\.confirmCleanupPermissionHandoffGrant\s*\|\|\s*type\s*===\s*MESSAGE_TYPES\.resumeCleanupPermissionHandoff\s*\?\s*270_000/,
    'the persistent-handoff grant and resume messages must share the long-running cleanup timeout'
  );
  validatePopupCapabilityMintAndBindingSemantics(requireSource('src/background/cleanup-preflight.js'), findings);
  validateNoRawPopupCapabilitySinks(
    [
      ['src/background/cleanup-preflight.js', requireSource('src/background/cleanup-preflight.js')],
      ['src/background/service-worker.js', requireSource('src/background/service-worker.js')],
      ['src/handoff/handoff.js', requireSource('src/handoff/handoff.js')],
      ['src/popup/popup.js', requireSource('src/popup/popup.js')],
      ['src/shared/state-schema.js', requireSource('src/shared/state-schema.js')]
    ],
    findings
  );

  const workerSource = requireSource('src/background/service-worker.js');
  if (workerSource) {
    const routeAt = workerSource.indexOf('case MESSAGE_TYPES.runDeepClean:');
    const consumeAt = workerSource.indexOf('consumeCleanupReviewRequest(payload', routeAt);
    const runAt = workerSource.indexOf('await runDeepClean(target, report', routeAt);
    if (routeAt < 0 || consumeAt < 0 || runAt < 0 || consumeAt >= runAt) {
      findings.push(
        'src/background/service-worker.js: the only cleanup route must consume prepared authority before runDeepClean'
      );
    }
    validateExternalRunDeepCleanWorkerBinding(workerSource, findings);
    validateServiceWorkerPopupContextSemantics(workerSource, findings);
    validateWorkerPromptInvocationRoute(workerSource, findings);
    validatePersistentPermissionHandoffBinding(workerSource, findings);
  }

  validateDurablePromptInvocationBoundary(requireSource('src/background/cleanup-preflight.js'), findings);
  validateUninvokedPermissionPreservation(
    requireSource('src/background/cleanup-preflight.js'),
    requireSource('src/background/permission-leases.js'),
    findings
  );
  validateDurablePermissionOwnershipProvenance(
    requireSource('src/background/cleanup-preflight.js'),
    requireSource('src/background/permission-leases.js'),
    requireSource('src/background/service-worker.js'),
    findings
  );
  validateInvalidReviewNeutralizationBoundary(
    requireSource('src/background/cleanup-preflight.js'),
    requireSource('src/background/permission-leases.js'),
    requireSource('src/background/service-worker.js'),
    findings
  );
  validatePromptTerminalReplayOrdering(
    requireSource('src/background/cleanup-preflight.js'),
    requireSource('src/background/permission-leases.js'),
    requireSource('src/background/service-worker.js'),
    findings
  );

  requirePattern(
    'src/background/cleanup-authorization.js',
    /\[['"]detailed_review['"],\s*['"]settings_direct['"]\]\.includes\(approvalMode\)/,
    'the independent authorization boundary must allow only the two prepared modes'
  );
  requirePattern(
    'src/background/cleanup-authorization.js',
    /approvalMode\s*===\s*['"]settings_direct['"]\s*&&\s*settings\?\.skipCleanupReview\s*!==\s*true/,
    'the independent boundary must reject direct mode when its effective setting is not true'
  );
  for (const marker of [
    'cleanupApprovalMode = approvalMode',
    'scopeReviewApproved = usedDetailedReview',
    'settingsDirectCleanupAuthorized = !usedDetailedReview',
    'directCleanupAuthorizedAt'
  ]) {
    requirePattern(
      'src/background/cleanup-authorization.js',
      new RegExp(escapeRegExp(marker).replaceAll('\\ ', '\\s+')),
      `truthful report evidence must retain ${marker}`
    );
  }

  const combined = Object.values(sources)
    .filter((value) => typeof value === 'string')
    .join('\n');
  const forbidden = [
    /runPreparedQuickCleanup|prepareOneClickCleanup|isQuickCleanupSettingActive/,
    /quickCleanupAllowed|quickCleanupBlockedReasons|quickApproval/i,
    /\bapprovalMode\s*(?::|={2,3})\s*['"](?:quick|bypass)['"]/i
  ];
  if (forbidden.some((pattern) => pattern.test(combined))) {
    findings.push('runtime: a retired quick/bypass route or approval mode is present');
  }

  return [...new Set(findings)];
}

function validateRunDeepCleanMessageContract(source, findings) {
  const route = sourceRange(source, 'case MESSAGE_TYPES.runDeepClean:', 'case MESSAGE_TYPES.validateAssociatedGroups:');
  const internalFields = quotedArrayPattern(INTERNAL_ARMED_CLEANUP_FIELDS);
  const externalFields = quotedArrayPattern(EXTERNAL_RUN_DEEP_CLEAN_FIELDS);
  const exactConditionalAllowlist = new RegExp(
    `validationOptions\\.allowInternalArmedCleanup\\s*===\\s*true\\s*\\?\\s*${internalFields}\\s*:\\s*${externalFields}`
  );
  const requiresExternalBinding =
    /validationOptions\.allowInternalArmedCleanup\s*!==\s*true\)\s*assertPopupPreparationBinding\(payload\)/.test(
      route
    );
  const exposesForbiddenAuthority = FORBIDDEN_CALLER_AUTHORITY_FIELDS.some((field) =>
    new RegExp(`['"]${escapeRegExp(field)}['"]`).test(route)
  );
  if (!route || !exactConditionalAllowlist.test(route) || !requiresExternalBinding || exposesForbiddenAuthority) {
    findings.push(
      'src/shared/message-contracts.js: runDeepClean must allow only prepared approval/context fields plus required worker-minted popup binding credentials'
    );
  }
  validateRunDeepCleanMessageAst(source, findings);
}

function validateBeginCleanupPermissionPromptMessageContract(source, findings) {
  const compact = source.replace(/\s+/g, '').replaceAll('"', "'");
  const exactBegin = compact.includes(
    "caseMESSAGE_TYPES.beginCleanupPermissionHandoff:assertKeys(payload,['handoffNonce','handoffCapability']);assertPermissionLeaseId(payload.handoffNonce);"
  );
  const exactInvocationAndResume = compact.includes(
    "caseMESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation:caseMESSAGE_TYPES.resumeCleanupPermissionHandoff:assertKeys(payload,['handoffNonce','handoffCapability']);assertPermissionLeaseId(payload.handoffNonce);assertPermissionHandoffCapability(payload.handoffCapability);return;"
  );
  const exactGrant = compact.includes(
    "caseMESSAGE_TYPES.confirmCleanupPermissionHandoffGrant:assertKeys(payload,['handoffNonce','handoffCapability','preRequestTemporaryOriginsAbsent']);assertPermissionLeaseId(payload.handoffNonce);assertPermissionHandoffCapability(payload.handoffCapability);if(payload.preRequestTemporaryOriginsAbsent!==true)"
  );
  const exactSettlement = compact.includes(
    "caseMESSAGE_TYPES.settleCleanupPermissionHandoff:assertKeys(payload,['handoffNonce','handoffCapability','outcome']);assertPermissionLeaseId(payload.handoffNonce);assertPermissionHandoffCapability(payload.handoffCapability);"
  );
  if (!exactBegin || !exactInvocationAndResume || !exactGrant || !exactSettlement) {
    findings.push(
      'src/shared/message-contracts.js: every persistent-handoff authority message must require only its exact nonce, one-use capability, and bounded outcome attestation'
    );
  }
}

function _validateLegacyBeginCleanupPermissionPromptMessageContract(source, findings) {
  const sourceFile = parseJavaScriptSource('src/shared/message-contracts.js', source, findings);
  if (!sourceFile) return;
  const beginCase = findCaseClause(sourceFile, 'MESSAGE_TYPES.beginCleanupPermissionPrompt');
  const confirmCase = findCaseClause(sourceFile, 'MESSAGE_TYPES.confirmCleanupPermissionPromptInvocation');
  const outcomeCase = findCaseClause(sourceFile, 'MESSAGE_TYPES.confirmCleanupPermissionGrantOutcome');
  const confirmStatements = caseStatements(confirmCase);
  const outcomeStatements = caseStatements(outcomeCase);
  const confirmAssertKeys = confirmStatements.length ? directCallFromStatement(confirmStatements[0]) : null;
  const outcomeAssertKeys = outcomeStatements.length ? directCallFromStatement(outcomeStatements[0]) : null;
  const hasNonceAndPopupBindingChecks = (statements) =>
    statements.some(
      (statement) =>
        callName(directCallFromStatement(statement)) === 'assertPermissionLeaseId' &&
        memberPath(directCallFromStatement(statement)?.arguments?.[0]) === 'payload.handoffNonce'
    ) &&
    statements.some(
      (statement) =>
        callName(directCallFromStatement(statement)) === 'assertPopupPreparationBinding' &&
        memberPath(directCallFromStatement(statement)?.arguments?.[0]) === 'payload'
    ) &&
    statements.at(-1)?.type === 'ReturnStatement';
  const exactInvocationPayload = Boolean(
    beginCase &&
    confirmCase &&
    outcomeCase &&
    beginCase.consequent.length === 0 &&
    beginCase.end <= confirmCase.start &&
    confirmCase.end <= outcomeCase.start &&
    callName(confirmAssertKeys) === 'assertKeys' &&
    memberPath(confirmAssertKeys?.arguments?.[0]) === 'payload' &&
    sameStrings(stringArrayValues(confirmAssertKeys?.arguments?.[1]), [
      'handoffNonce',
      'popupContextId',
      'popupPreparationCapability'
    ]) &&
    hasNonceAndPopupBindingChecks(confirmStatements)
  );
  const exactOutcomePayload = Boolean(
    callName(outcomeAssertKeys) === 'assertKeys' &&
    memberPath(outcomeAssertKeys?.arguments?.[0]) === 'payload' &&
    sameStrings(stringArrayValues(outcomeAssertKeys?.arguments?.[1]), [
      'handoffNonce',
      'preRequestTemporaryOriginsAbsent',
      'popupContextId',
      'popupPreparationCapability'
    ]) &&
    outcomeStatements.some(
      (statement) =>
        statement.type === 'IfStatement' &&
        compactNodeText(statement.test, sourceFile) === 'payload.preRequestTemporaryOriginsAbsent!==true' &&
        (containsCallNamed(statement.consequent, 'fail') || containsNodeType(statement.consequent, 'ThrowStatement'))
    ) &&
    hasNonceAndPopupBindingChecks(outcomeStatements)
  );
  if (!exactInvocationPayload || !exactOutcomePayload) {
    findings.push(
      'src/shared/message-contracts.js: begin and invocation-confirm must accept only the nonce and exact popup binding; grant-outcome-confirm must additionally require literal pre-request temporary-origin absence'
    );
  }
}

function validatePopupPermissionActivationContract(popupSource, handoffSource, findings) {
  const popupFile = parseJavaScriptSource('src/popup/popup.js', popupSource, findings);
  const handoffFile = parseJavaScriptSource('src/handoff/handoff.js', handoffSource, findings);
  if (!popupFile || !handoffFile) return;

  const armedHelper = findNamedFunction(popupFile, 'cleanupApprovalHandoffIsArmed');
  const armedStatements = armedHelper?.body?.body || [];
  const strictArmed = Boolean(
    armedStatements.length === 1 &&
    armedStatements[0]?.type === 'ReturnStatement' &&
    compactNodeText(armedStatements[0].argument, popupFile).replaceAll('"', "'") ===
      "review?.approvalHandoffStatus==='armed'&&review?.approvalHandoffArmed===true"
  );
  if (!strictArmed) {
    findings.push(
      'src/popup/popup.js: the fresh permission activation must depend on an immutable strict-local armed flag requiring both exact armed markers'
    );
  }

  const run = findNamedFunction(popupFile, 'runPreparedCleanup');
  const popupText = compactNodeText(run?.body, popupFile).replaceAll('"', "'");
  const armAt = popupText.indexOf('armed=awaitsendMessage(MESSAGE_TYPES.armCleanupApproval');
  const armAckAt = popupText.indexOf('armed?.approvalArmed!==true', armAt);
  const armStatusAt = popupText.indexOf("armed?.handoffStatus!=='armed'", armAckAt);
  const armNonceAt = popupText.indexOf('armed?.handoffNonce!==review.approvalHandoffNonce', armStatusAt);
  const openAt = popupText.indexOf('awaitsendMessage(MESSAGE_TYPES.openCleanupPermissionHandoff', armNonceAt);
  const openedAckAt = popupText.indexOf('opened?.handoffOpened!==true', openAt);
  const pregrantedAt = popupText.indexOf('clearPreparedReviewExpiry(direct);if((direct?', openedAckAt);
  const missingBranchTail = pregrantedAt > openedAckAt ? popupText.slice(openedAckAt, pregrantedAt) : '';
  if (!(armAt >= 0 && armAt < armAckAt && armAckAt < armStatusAt && armStatusAt < armNonceAt)) {
    findings.push(
      'src/popup/popup.js: missing-access approval must await and verify the exact durable first-activation arm acknowledgement'
    );
  }
  if (
    openAt < armNonceAt ||
    openedAckAt < openAt ||
    !missingBranchTail.includes('return;') ||
    /chrome\.permissions\.(?:getAll|request)/.test(popupSource) ||
    /MESSAGE_TYPES\.(?:beginCleanupPermissionPrompt|confirmCleanupPermissionPromptInvocation|confirmCleanupPermissionGrantOutcome|resumeArmedCleanup|settleCleanupPermissionPrompt)/.test(
      popupSource
    )
  ) {
    findings.push(
      'src/popup/popup.js: missing-access approval must open the exact persistent handoff after arming, stop in the popup, and never invoke a permission or retired continuation route'
    );
  }

  const activation = findNamedFunction(handoffFile, 'runReviewedPermissionHandoff');
  const activationText = compactNodeText(activation?.body, handoffFile).replaceAll('"', "'");
  const beginAt = activationText.indexOf(
    'intentPromise=sendMessage(MESSAGE_TYPES.beginCleanupPermissionHandoff,authority)'
  );
  const inventoryAt = activationText.indexOf('snapshotPromise=chrome.permissions.getAll()', beginAt);
  const requestAt = activationText.indexOf(
    'permissionRequest=chrome.permissions.request({origins:handoff.origins})',
    inventoryAt
  );
  const invocationAt = activationText.indexOf(
    'sendMessage(MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,authority)',
    requestAt
  );
  const awaitAllAt = activationText.indexOf('awaitPromise.all([', invocationAt);
  const exactActivation = Boolean(
    activation &&
    activationText.includes('globalThis.navigator?.userActivation') &&
    activationText.includes('globalThis.navigator.userActivation.isActive!==true') &&
    beginAt >= 0 &&
    beginAt < inventoryAt &&
    inventoryAt < requestAt &&
    requestAt < invocationAt &&
    invocationAt < awaitAllAt &&
    !activationText.slice(beginAt, requestAt).includes('await') &&
    activationText.includes(
      'returnfailClosed(error);}constinvocationPromise=sendMessage(MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,authority)'
    ) &&
    activationText.includes('awaitPromise.all([intentPromise,invocationPromise,') &&
    activationText.includes(
      'preRequestTemporaryOriginsAbsent=snapshot.ok&&temporaryHostAccessWasAbsent(snapshot.value,handoff.origins)'
    ) &&
    activationText.includes(
      '!intent.ok||!invocation.ok||!snapshot.ok||!preRequestTemporaryOriginsAbsent||!request.ok'
    ) &&
    activationText.includes('request.value!==true') &&
    activationText.includes('awaitsendMessage(MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,{') &&
    activationText.includes('preRequestTemporaryOriginsAbsent:true') &&
    activationText.includes('sendMessage(MESSAGE_TYPES.resumeCleanupPermissionHandoff,authority)') &&
    activationText.includes('renderOutcome(result)') &&
    activationText.includes('renderOutcome(resumed)') &&
    activationText.includes("awaitsettleHandoff('not_invoked')")
  );
  const inventory = findNamedFunction(handoffFile, 'temporaryHostAccessWasAbsent');
  const inventoryText = compactNodeText(inventory?.body, handoffFile);
  const exactInventory = Boolean(
    inventory &&
    inventoryText.includes('inventory.exactGrantedHostPermissionOrigins.length===0') &&
    inventoryText.includes('inventory.broadGrantedHostPermissionOrigins.length===0')
  );
  if (!exactActivation || !exactInventory) {
    findings.push(
      'src/handoff/handoff.js: activation two must begin without await, synchronously inventory immediately before requesting access, immediately confirm invocation, and report literal true only with valid pre-request absence before resume; synchronous throw must settle not_invoked'
    );
  }
}

function _validateLegacyPopupPermissionActivationContract(source, findings) {
  const sourceFile = parseJavaScriptSource('src/popup/popup.js', source, findings);
  if (!sourceFile) return;

  const armedHelper = findNamedFunction(sourceFile, 'cleanupApprovalHandoffIsArmed');
  const armedHelperStatements = armedHelper?.body?.body || [];
  const armedHelperReturn = armedHelperStatements[0];
  const strictArmedHelper = Boolean(
    armedHelperStatements.length === 1 &&
    armedHelperReturn?.type === 'ReturnStatement' &&
    compactNodeText(armedHelperReturn.argument, sourceFile).replaceAll('"', "'") ===
      "review?.approvalHandoffStatus==='armed'&&review?.approvalHandoffArmed===true"
  );

  const runFunction = findNamedFunction(sourceFile, 'runPreparedCleanup');
  const runStatements = runFunction?.body?.body || [];
  const armedSnapshotStatement = runStatements.find(
    (statement) =>
      statement.type === 'VariableDeclaration' &&
      statement.kind === 'const' &&
      statement.declarations.some(
        (declaration) =>
          declaration.id?.type === 'Identifier' && declaration.id.name === 'permissionHandoffArmedAtStart'
      )
  );
  const armedSnapshot = armedSnapshotStatement?.declarations.find(
    (declaration) => declaration.id?.type === 'Identifier' && declaration.id.name === 'permissionHandoffArmedAtStart'
  );
  const armedSnapshotCall = unwrapExpression(armedSnapshot?.init);
  const strictLocalArmedSnapshot = Boolean(
    armedSnapshotCall?.type === 'CallExpression' &&
    memberPath(armedSnapshotCall.callee) === 'cleanupApprovalHandoffIsArmed' &&
    armedSnapshotCall.arguments.length === 1 &&
    memberPath(armedSnapshotCall.arguments[0]) === 'review'
  );
  if (!strictArmedHelper || !strictLocalArmedSnapshot) {
    findings.push(
      'src/popup/popup.js: the fresh permission activation must depend on an immutable strict-local armed flag requiring both exact armed markers'
    );
  }

  if (!runFunction) {
    findings.push(
      'src/popup/popup.js: missing-access approval must await and verify the exact durable first-activation arm acknowledgement'
    );
    findings.push(
      'src/popup/popup.js: missing-access approval must stop after arming and require a separate fresh permission activation'
    );
    findings.push(
      'src/popup/popup.js: activation two must dispatch authenticated begin intent, synchronously invoke permissions.request, and immediately dispatch authenticated confirm without awaiting those outcomes'
    );
    return;
  }

  const permissionCalls = [];
  const permissionInventoryCalls = [];
  walkNodes(runFunction.body, (node) => {
    if (node.type === 'CallExpression' && memberPath(node.callee) === 'chrome.permissions.request') {
      permissionCalls.push(node);
    }
    if (node.type === 'CallExpression' && memberPath(node.callee) === 'chrome.permissions.getAll') {
      permissionInventoryCalls.push(node);
    }
  });
  const permissionCall = permissionCalls.length === 1 ? permissionCalls[0] : null;
  const permissionInventoryCall = permissionInventoryCalls.length === 1 ? permissionInventoryCalls[0] : null;
  const permissionStatement = permissionCall
    ? findNode(
        runFunction.body,
        (node) =>
          node.type === 'ExpressionStatement' &&
          node.expression?.type === 'AssignmentExpression' &&
          node.expression.operator === '=' &&
          memberPath(node.expression.left) === 'permissionRequest' &&
          node.expression.right === permissionCall
      )
    : null;
  const permissionInventoryStatement = permissionInventoryCall
    ? findNode(
        runFunction.body,
        (node) =>
          node.type === 'ExpressionStatement' &&
          node.expression?.type === 'AssignmentExpression' &&
          node.expression.operator === '=' &&
          memberPath(node.expression.left) === 'preRequestPermissionSnapshot' &&
          node.expression.right === permissionInventoryCall
      )
    : null;

  const missingAccessGuard = permissionCall
    ? findNode(
        runFunction.body,
        (node) =>
          node.type === 'IfStatement' &&
          compactNodeText(node.test, sourceFile) === '!review.hostPermissionsGranted' &&
          node.consequent?.type === 'BlockStatement' &&
          nodeContains(node.consequent, permissionCall)
      )
    : null;
  const missingAccessStatements = missingAccessGuard?.consequent?.body || [];
  const armGuard = missingAccessStatements.find(
    (statement) =>
      statement.type === 'IfStatement' && isNegatedIdentifier(statement.test, 'permissionHandoffArmedAtStart')
  );
  const armTry = armGuard
    ? findNode(
        armGuard.consequent,
        (node) =>
          node.type === 'TryStatement' &&
          Boolean(
            findNode(
              node.block,
              (candidate) =>
                candidate.type === 'CallExpression' &&
                memberPath(candidate.callee) === 'sendMessage' &&
                compactNodeText(candidate.arguments?.[0], sourceFile) === 'MESSAGE_TYPES.armCleanupApproval'
            )
          )
      )
    : null;
  const armStatements = armTry?.block?.body || [];
  const armAssignmentStatement = armStatements[0];
  const armAssignment = armAssignmentStatement?.expression;
  const armAwait = armAssignment?.right;
  const armCall = unwrapExpression(armAwait);
  const ackGuard = armStatements[1];
  const ackTerms = ackGuard?.type === 'IfStatement' ? flattenLogicalOr(ackGuard.test) : [];
  const exactAckTerms = Boolean(
    ackTerms.length === 3 &&
    isExactBinaryComparison(ackTerms[0], 'armed.approvalArmed', '!==', true) &&
    isExactBinaryComparison(ackTerms[1], 'armed.handoffStatus', '!==', 'armed') &&
    isExactMemberComparison(ackTerms[2], 'armed.handoffNonce', '!==', 'review.approvalHandoffNonce')
  );
  const localArmedAssignment = armStatements.find(
    (statement) =>
      statement.type === 'ExpressionStatement' &&
      isExactAssignment(statement.expression, 'review.approvalHandoffArmed', true)
  );
  const localStatusAssignment = armStatements.find(
    (statement) =>
      statement.type === 'ExpressionStatement' &&
      isExactAssignment(statement.expression, 'review.approvalHandoffStatus', 'armed')
  );
  const finalArmReturn = armStatements.at(-1);
  const durableArmAcknowledgement = Boolean(
    armGuard?.consequent?.type === 'BlockStatement' &&
    armTry &&
    armAssignmentStatement?.type === 'ExpressionStatement' &&
    armAssignment?.type === 'AssignmentExpression' &&
    armAssignment.operator === '=' &&
    memberPath(armAssignment.left) === 'armed' &&
    armAwait?.type === 'AwaitExpression' &&
    armCall?.type === 'CallExpression' &&
    memberPath(armCall.callee) === 'sendMessage' &&
    compactNodeText(armCall.arguments?.[0], sourceFile) === 'MESSAGE_TYPES.armCleanupApproval' &&
    ackGuard?.type === 'IfStatement' &&
    exactAckTerms &&
    containsNodeType(ackGuard.consequent, 'ThrowStatement') &&
    localArmedAssignment?.start > ackGuard.end &&
    localStatusAssignment?.start > ackGuard.end &&
    finalArmReturn?.type === 'ReturnStatement' &&
    finalArmReturn.argument == null &&
    localArmedAssignment.end < finalArmReturn.start &&
    localStatusAssignment.end < finalArmReturn.start
  );
  if (!durableArmAcknowledgement) {
    findings.push(
      'src/popup/popup.js: missing-access approval must await and verify the exact durable first-activation arm acknowledgement'
    );
  }

  const permissionOutsideArm = Boolean(
    permissionCall &&
    armGuard &&
    missingAccessGuard &&
    permissionCall.start > armGuard.end &&
    !nodeContains(armGuard, permissionCall) &&
    finalArmReturn?.type === 'ReturnStatement'
  );
  if (!permissionOutsideArm) {
    findings.push(
      'src/popup/popup.js: missing-access approval must stop after arming and require a separate fresh permission activation'
    );
  }

  const freshActivationGuard = missingAccessStatements.find(
    (statement) =>
      statement.type === 'IfStatement' &&
      compactNodeText(statement.test, sourceFile) ===
        'globalThis.navigator?.userActivation&&globalThis.navigator.userActivation.isActive!==true' &&
      containsNodeType(statement.consequent, 'ThrowStatement')
  );
  const promptIntentDeclaration = findVariableDeclaration(missingAccessGuard?.consequent, 'promptIntent', {
    directStatementsOnly: true
  });
  const promptIntentThenCall = unwrapExpression(promptIntentDeclaration?.init);
  const promptIntentDispatchCall = promptIntentThenCall
    ? findCallExpression(
        promptIntentThenCall,
        (call) =>
          memberPath(call.callee) === 'sendMessage' &&
          compactNodeText(call.arguments?.[0], sourceFile) === 'MESSAGE_TYPES.beginCleanupPermissionPrompt'
      )
    : null;
  const promptIntentPayloadText = compactNodeText(promptIntentDispatchCall?.arguments?.[1], sourceFile);
  const permissionTry = permissionCall
    ? findNode(
        missingAccessGuard?.consequent,
        (node) => node.type === 'TryStatement' && nodeContains(node.block, permissionCall)
      )
    : null;
  const promptInvocationDeclaration = findVariableDeclaration(missingAccessGuard?.consequent, 'promptInvocation', {
    directStatementsOnly: true
  });
  const promptInvocationThenCall = unwrapExpression(promptInvocationDeclaration?.init);
  const promptInvocationDispatchCall = promptInvocationThenCall
    ? findCallExpression(
        promptInvocationThenCall,
        (call) =>
          memberPath(call.callee) === 'sendMessage' &&
          compactNodeText(call.arguments?.[0], sourceFile) === 'MESSAGE_TYPES.confirmCleanupPermissionPromptInvocation'
      )
    : null;
  const promptInvocationPayloadText = compactNodeText(promptInvocationDispatchCall?.arguments?.[1], sourceFile);
  let priorAwait = null;
  if (armGuard && permissionCall) {
    walkNodes(runFunction.body, (node) => {
      if (node.start < armGuard.end || node.end > permissionCall.start) return;
      if (!priorAwait && node.type === 'AwaitExpression') priorAwait = node;
    });
  }
  let awaitBetweenBeginAndPermission = null;
  if (promptIntentDispatchCall && permissionCall) {
    walkNodes(runFunction.body, (node) => {
      if (node.start <= promptIntentDispatchCall.end || node.end >= permissionCall.start) return;
      if (!awaitBetweenBeginAndPermission && node.type === 'AwaitExpression') awaitBetweenBeginAndPermission = node;
    });
  }
  const synchronousThrowCatchText = compactNodeText(permissionTry?.handler?.body, sourceFile);
  const compactRunText = compactNodeText(runFunction.body, sourceFile);
  const beginDispatchAt = compactRunText.indexOf(
    'constpromptIntent=sendMessage(MESSAGE_TYPES.beginCleanupPermissionPrompt,'
  );
  const permissionRequestAt = compactRunText.indexOf('permissionRequest=chrome.permissions.request({origins})');
  const permissionInventoryAt = compactRunText.indexOf('preRequestPermissionSnapshot=chrome.permissions.getAll()');
  const confirmDispatchAt = compactRunText.indexOf(
    'constpromptInvocation=sendMessage(MESSAGE_TYPES.confirmCleanupPermissionPromptInvocation,'
  );
  const jointOutcomeWait = promptInvocationDispatchCall
    ? findNode(
        runFunction.body,
        (node) =>
          node.type === 'AwaitExpression' &&
          node.argument?.type === 'CallExpression' &&
          memberPath(node.argument.callee) === 'Promise.all' &&
          node.argument.arguments?.[0]?.type === 'ArrayExpression' &&
          node.argument.arguments[0].elements?.length === 4 &&
          memberPath(node.argument.arguments[0].elements?.[0]) === 'promptIntent' &&
          memberPath(node.argument.arguments[0].elements?.[1]) === 'promptInvocation' &&
          compactNodeText(node.argument.arguments[0].elements?.[2], sourceFile).includes(
            'Promise.resolve(preRequestPermissionSnapshot)'
          ) &&
          compactNodeText(node.argument.arguments[0].elements?.[3], sourceFile).includes(
            'Promise.resolve(permissionRequest)'
          )
      )
    : null;
  const grantOutcomeDeclaration = findVariableDeclaration(missingAccessGuard?.consequent, 'grantOutcome', {
    directStatementsOnly: true
  });
  const grantOutcomeAwait = grantOutcomeDeclaration?.init;
  const grantOutcomeDispatchCall = unwrapExpression(grantOutcomeAwait);
  const grantOutcomePayloadText = compactNodeText(grantOutcomeDispatchCall?.arguments?.[1], sourceFile);
  const nativeGrantGuard = missingAccessStatements.find(
    (statement) => statement.type === 'IfStatement' && compactNodeText(statement.test, sourceFile) === 'granted!==true'
  );
  const grantOutcomeAckGuard = missingAccessStatements.find(
    (statement) =>
      statement.type === 'IfStatement' &&
      compactNodeText(statement.test, sourceFile) ===
        'grantOutcome?.promptGrantOutcomeRecorded!==true||grantOutcome?.handoffNonce!==review.approvalHandoffNonce'
  );
  const grantOutcomeDispatchAt = compactRunText.indexOf(
    'constgrantOutcome=awaitsendMessage(MESSAGE_TYPES.confirmCleanupPermissionGrantOutcome,'
  );
  const resumeDispatchAt = compactRunText.indexOf(
    'awaitsendMessage(MESSAGE_TYPES.resumeArmedCleanup,',
    grantOutcomeDispatchAt
  );
  const permissionTryStatements = permissionTry?.block?.body || [];
  const inventoryStatementAt = permissionTryStatements.indexOf(permissionInventoryStatement);
  const requestStatementAt = permissionTryStatements.indexOf(permissionStatement);
  const absenceHelper = findNamedFunction(sourceFile, 'temporaryHostAccessWasAbsent');
  const absenceHelperText = compactNodeText(absenceHelper?.body, sourceFile).replaceAll('"', "'");
  const strictPreRequestInventory = Boolean(
    permissionInventoryCall &&
    permissionInventoryCall.arguments.length === 0 &&
    permissionInventoryStatement &&
    permissionTry &&
    inventoryStatementAt >= 0 &&
    requestStatementAt === inventoryStatementAt + 1 &&
    permissionInventoryAt > beginDispatchAt &&
    permissionRequestAt > permissionInventoryAt &&
    !compactRunText.slice(permissionInventoryAt, permissionRequestAt).includes('await') &&
    absenceHelper &&
    absenceHelperText.includes("!snapshot||typeofsnapshot!=='object'||Array.isArray(snapshot)") &&
    absenceHelperText.includes('!Array.isArray(snapshot.origins)') &&
    absenceHelperText.includes("snapshot.origins.some((origin)=>typeoforigin!=='string')") &&
    absenceHelperText.includes('constcanonicalOrigins=canonicalizeHostPermissionOrigins(snapshot.origins)') &&
    absenceHelperText.includes('canonicalOrigins.length!==snapshot.origins.length') &&
    absenceHelperText.includes('requiredOrigins,coveredRequiredOrigins:[],grantedOrigins:canonicalOrigins') &&
    absenceHelperText.includes('inventory.exactGrantedHostPermissionOrigins.length===0') &&
    absenceHelperText.includes('inventory.broadGrantedHostPermissionOrigins.length===0') &&
    compactRunText.includes(
      'constpreRequestTemporaryOriginsAbsent=snapshotOutcome.ok&&temporaryHostAccessWasAbsent(snapshotOutcome.value,origins)'
    ) &&
    compactRunText.includes(
      '!intent.ok||!invocation.ok||!snapshotOutcome.ok||!preRequestTemporaryOriginsAbsent||!requestOutcome.ok'
    )
  );
  const exactTwoPhasePromptHandshake = Boolean(
    permissionCall &&
    permissionTry &&
    promptIntentDispatchCall &&
    promptIntentPayloadText === '{handoffNonce:review.approvalHandoffNonce,...popupBinding}' &&
    promptInvocationDispatchCall &&
    promptInvocationPayloadText === '{handoffNonce:review.approvalHandoffNonce,...popupBinding}' &&
    compactRunText.includes('response?.promptIntentRecorded===true') &&
    compactRunText.includes('response?.promptInvocationRecorded===true') &&
    !awaitBetweenBeginAndPermission &&
    synchronousThrowCatchText.includes('constintent=awaitpromptIntent') &&
    synchronousThrowCatchText.includes('if(intent.ok)') &&
    synchronousThrowCatchText.includes("awaitsettleCleanupPermissionPrompt(review,'not_invoked')") &&
    !synchronousThrowCatchText.includes('confirmCleanupPermissionPromptInvocation') &&
    jointOutcomeWait?.start > promptInvocationDispatchCall.end &&
    nativeGrantGuard?.start > jointOutcomeWait?.end &&
    grantOutcomeDeclaration?.start > nativeGrantGuard?.end &&
    grantOutcomeAwait?.type === 'AwaitExpression' &&
    grantOutcomeDispatchCall?.type === 'CallExpression' &&
    memberPath(grantOutcomeDispatchCall.callee) === 'sendMessage' &&
    compactNodeText(grantOutcomeDispatchCall.arguments?.[0], sourceFile) ===
      'MESSAGE_TYPES.confirmCleanupPermissionGrantOutcome' &&
    grantOutcomePayloadText ===
      '{handoffNonce:review.approvalHandoffNonce,preRequestTemporaryOriginsAbsent:true,...popupBinding}' &&
    grantOutcomeAckGuard?.start > grantOutcomeDeclaration.end &&
    beginDispatchAt >= 0 &&
    strictPreRequestInventory &&
    permissionRequestAt > beginDispatchAt &&
    confirmDispatchAt > permissionRequestAt &&
    grantOutcomeDispatchAt > confirmDispatchAt &&
    resumeDispatchAt > grantOutcomeDispatchAt &&
    !compactRunText.slice(beginDispatchAt, permissionRequestAt).includes('await') &&
    compactRunText.includes(
      'awaitPromise.all([promptIntent,promptInvocation,Promise.resolve(preRequestPermissionSnapshot).then('
    )
  );
  const permissionRequestIsSynchronousBeforeAwait = Boolean(
    permissionCall &&
    permissionStatement &&
    permissionCall.arguments.length === 1 &&
    compactNodeText(permissionCall.arguments[0], sourceFile) === '{origins}' &&
    freshActivationGuard &&
    armGuard &&
    freshActivationGuard.start > armGuard.end &&
    freshActivationGuard.end < permissionCall.start &&
    exactTwoPhasePromptHandshake &&
    !priorAwait &&
    !containsNodeType(permissionStatement, 'AwaitExpression')
  );
  if (!permissionRequestIsSynchronousBeforeAwait) {
    findings.push(
      'src/popup/popup.js: activation two must begin without await, synchronously inventory immediately before requesting access, immediately confirm invocation, and report literal true only with valid pre-request absence before resume; synchronous throw must settle not_invoked'
    );
  }
}

function validateDurablePromptInvocationBoundary(preflightSource, findings) {
  const sourceFile = parseJavaScriptSource('src/background/cleanup-preflight.js', preflightSource, findings);
  if (!sourceFile) return;

  const stageFunction = findNamedFunction(sourceFile, 'stageCleanupReviewApprovalRequest');
  const armingHandoff = stageFunction ? findVariableDeclaration(stageFunction.body, 'armingHandoff') : null;
  const armingText = compactNodeText(armingHandoff?.init, sourceFile);
  const intentFunction = findNamedFunction(sourceFile, 'recordCleanupPermissionPromptIntent');
  const intentText = compactNodeText(intentFunction?.body, sourceFile).replaceAll('"', "'");
  const invocationFunction = findNamedFunction(sourceFile, 'recordCleanupPermissionPromptInvocation');
  const invocationText = compactNodeText(invocationFunction?.body, sourceFile).replaceAll('"', "'");
  const grantOutcomeFunction = findNamedFunction(sourceFile, 'recordCleanupPermissionGrantOutcome');
  const grantOutcomeText = compactNodeText(grantOutcomeFunction?.body, sourceFile).replaceAll('"', "'");
  const promptIntentDeclaration = findVariableDeclaration(intentFunction?.body, 'promptIntent');
  const intentWrites = [];
  const promptInvocationWrites = [];
  if (intentFunction) {
    walkNodes(intentFunction.body, (node) => {
      if (
        node.type === 'CallExpression' &&
        memberPath(node.callee) === 'storageSession.set' &&
        node.start > promptIntentDeclaration?.end &&
        compactNodeText(node.arguments?.[0], sourceFile) === '{[CLEANUP_REVIEW_STORAGE_KEY]:retainedRecord}'
      ) {
        intentWrites.push(node);
      }
    });
  }
  if (invocationFunction) {
    walkNodes(invocationFunction.body, (node) => {
      if (
        node.type === 'CallExpression' &&
        memberPath(node.callee) === 'storageSession.set' &&
        compactNodeText(node.arguments?.[0], sourceFile).includes('promptInvocation')
      ) {
        promptInvocationWrites.push(node);
      }
    });
  }
  const everyIntentWriteIsAwaited =
    intentWrites.length > 0 &&
    intentWrites.every((write) =>
      Boolean(
        findNode(
          intentFunction?.body,
          (node) => node.type === 'AwaitExpression' && unwrapExpression(node.argument) === write
        )
      )
    );
  const everyPromptInvocationWriteIsAwaited = promptInvocationWrites.every((write) =>
    Boolean(
      findNode(
        invocationFunction?.body,
        (node) => node.type === 'AwaitExpression' && unwrapExpression(node.argument) === write
      )
    )
  );
  const intentValueAt = intentText.indexOf('constpromptIntent=');
  const intentDurableWriteAt = intentText.indexOf('awaitstorageSession.set(', intentValueAt);
  const intentAckAt = intentText.lastIndexOf('promptIntentRecorded:true');
  const invocationValueAt = invocationText.lastIndexOf('constpromptInvocation=');
  const invocationDurableWriteAt = invocationText.indexOf('awaitstorageSession.set(', invocationValueAt);
  const invocationAckAt = invocationText.lastIndexOf('promptInvocationRecorded:true');
  const exactDurableTwoPhaseMarker = Boolean(
    /export\s+const\s+CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION\s*=\s*3\s*;/.test(preflightSource) &&
    armingText.includes('promptIntent:null') &&
    armingText.includes('promptInvocation:null') &&
    armingText.includes('promptGrant:null') &&
    armingText.includes('promptGrantOutcome:null') &&
    intentFunction &&
    intentText.includes("record.approvalHandoff.status!=='armed'") &&
    intentText.includes('record.approvalHandoff.nonce!==handoffNonce') &&
    intentText.includes(
      'if(dependencies.requirePopupPreparationCapability===true){awaitassertCleanupReviewPopupBinding(record,payload);}'
    ) &&
    !intentText.includes('assertPromptAccessUnchangedOrDiscard') &&
    intentText.includes('confirmationDeadlineMs:promptIntentAtMs+CLEANUP_PERMISSION_PROMPT_CONFIRM_GRACE_MS') &&
    everyIntentWriteIsAwaited &&
    intentValueAt >= 0 &&
    intentDurableWriteAt > intentValueAt &&
    intentAckAt > intentDurableWriteAt &&
    invocationFunction &&
    invocationText.includes(
      "['armed','prompt_intent_tombstone','prompt_tombstone'].includes(record.approvalHandoff.status)"
    ) &&
    invocationText.includes('record.approvalHandoff.nonce!==handoffNonce') &&
    invocationText.includes(
      'if(dependencies.requirePopupPreparationCapability===true){awaitassertCleanupReviewPopupBinding(record,payload);}'
    ) &&
    invocationText.includes('record.approvalHandoff.promptIntent?.popupContextId!==popupContextId') &&
    !invocationText.includes('assertPromptAccessUnchangedOrDiscard') &&
    promptInvocationWrites.length >= 1 &&
    everyPromptInvocationWriteIsAwaited &&
    invocationValueAt >= 0 &&
    invocationDurableWriteAt > invocationValueAt &&
    invocationAckAt > invocationDurableWriteAt
  );
  const normalizeFunction = findNamedFunction(sourceFile, 'normalizeCleanupApprovalHandoff');
  const normalizeText = compactNodeText(normalizeFunction?.body, sourceFile);
  const promptInvocationNormalizationAt = normalizeText.indexOf('letpromptInvocation=null');
  const promptGrantNormalizationAt = normalizeText.indexOf('letpromptGrant=null', promptInvocationNormalizationAt);
  const promptInvocationNormalizationText =
    promptInvocationNormalizationAt >= 0 && promptGrantNormalizationAt > promptInvocationNormalizationAt
      ? normalizeText.slice(promptInvocationNormalizationAt, promptGrantNormalizationAt)
      : '';
  const promptGrantNormalizationEnd = normalizeText.indexOf("if((value.status==='arming'", promptGrantNormalizationAt);
  const promptGrantNormalizationText =
    promptGrantNormalizationAt >= 0 && promptGrantNormalizationEnd > promptGrantNormalizationAt
      ? normalizeText.slice(promptGrantNormalizationAt, promptGrantNormalizationEnd)
      : '';
  const promptGrantOutcomeNormalizationAt = normalizeText.indexOf(
    'letpromptGrantOutcome=null',
    promptGrantNormalizationAt
  );
  const promptGrantOutcomeNormalizationText =
    promptGrantOutcomeNormalizationAt >= 0 && promptGrantNormalizationEnd > promptGrantOutcomeNormalizationAt
      ? normalizeText.slice(promptGrantOutcomeNormalizationAt, promptGrantNormalizationEnd)
      : '';
  const markerNormalizationIsBounded = Boolean(
    normalizeFunction &&
    normalizeText.includes("'prompt_intent_tombstone','prompt_tombstone'") &&
    normalizeText.includes('confirmationDeadlineMs!==recordedAtMs+CLEANUP_PERMISSION_PROMPT_CONFIRM_GRACE_MS') &&
    promptInvocationNormalizationText.includes('popupContextId!==promptContextId') &&
    normalizeText.includes('!Number.isSafeInteger(recordedAtMs)') &&
    normalizeText.includes('!promptIntent') &&
    normalizeText.includes('!promptTombstone&&recordedAtMs>binding.expiresAtMs') &&
    promptGrantNormalizationText.includes('value.promptGrant.complete!==complete') &&
    promptGrantNormalizationText.includes(
      'observedOrigins.some((origin)=>!binding.temporaryOrigins.includes(origin))'
    ) &&
    promptGrantNormalizationText.includes('recordedAtMs<promptIntent.recordedAtMs') &&
    !promptGrantNormalizationText.includes('recordedAtMs<(promptInvocation||promptIntent).recordedAtMs') &&
    promptGrantOutcomeNormalizationText.includes('!isPlainObject(value.promptGrantOutcome)||!promptInvocation') &&
    promptGrantOutcomeNormalizationText.includes('popupContextId!==promptContextId') &&
    promptGrantOutcomeNormalizationText.includes('value.promptGrantOutcome.granted!==true') &&
    promptGrantOutcomeNormalizationText.includes('value.promptGrantOutcome.preRequestTemporaryOriginsAbsent!==true') &&
    promptGrantOutcomeNormalizationText.includes('recordedAtMs<promptInvocation.recordedAtMs') &&
    normalizeText.includes(
      "value.status==='admitting'&&(!promptIntent||!promptInvocation||promptGrant?.complete!==true||promptGrantOutcome?.granted!==true)"
    ) &&
    normalizeText.includes('(promptIntentTombstone&&(!promptIntent||promptInvocation||promptGrantOutcome))') &&
    normalizeText.includes('(promptTombstone&&(!promptIntent||!promptInvocation))')
  );
  if (!exactDurableTwoPhaseMarker || !markerNormalizationIsBounded) {
    findings.push(
      'src/background/cleanup-preflight.js: schema-3 begin and confirm must durably record non-runnable intent and invocation without current-access inference'
    );
  }

  const exactDurableGrantOutcome = Boolean(
    grantOutcomeFunction &&
    grantOutcomeText.includes('payload.preRequestTemporaryOriginsAbsent!==true') &&
    grantOutcomeText.includes("!['armed','prompt_tombstone'].includes(record.approvalHandoff.status)") &&
    grantOutcomeText.includes('record.approvalHandoff.nonce!==handoffNonce') &&
    grantOutcomeText.includes('!record.approvalHandoff.promptInvocation') &&
    grantOutcomeText.includes('awaitassertCleanupReviewPopupBinding(record,payload)') &&
    grantOutcomeText.includes('popupContextId!==record.approvalHandoff.promptContextId') &&
    grantOutcomeText.includes('record.approvalHandoff.promptInvocation.popupContextId!==popupContextId') &&
    grantOutcomeText.includes('granted:true') &&
    grantOutcomeText.includes('preRequestTemporaryOriginsAbsent:true') &&
    grantOutcomeText.includes('awaitstorageSession.set({[CLEANUP_REVIEW_STORAGE_KEY]:retainedRecord})') &&
    grantOutcomeText.includes('promptGrantOutcomeRecorded:true') &&
    !grantOutcomeText.includes('promptGrant?.complete')
  );
  if (!exactDurableGrantOutcome) {
    findings.push(
      'src/background/cleanup-preflight.js: only the initiating popup may durably record literal true with pre-request temporary-origin absence, independently of event observation'
    );
  }

  const grantFunction = findNamedFunction(sourceFile, 'recordCleanupPermissionGrantObservation');
  const grantText = compactNodeText(grantFunction?.body, sourceFile).replaceAll('"', "'");
  const exactGrantObservation = Boolean(
    grantFunction &&
    grantText.includes('!Array.isArray(rawOrigins)||!rawOrigins.length') &&
    grantText.includes("rawOrigins.some((origin)=>typeoforigin!=='string')") &&
    grantText.includes('newSet(rawOrigins).size!==rawOrigins.length') &&
    grantText.includes('rawNamedPermissions!=null') &&
    grantText.includes('rawNamedPermissions.length>0') &&
    grantText.includes('constaddedOrigins=canonicalizeHostPermissionOrigins(rawOrigins)') &&
    grantText.includes('addedOrigins.length!==rawOrigins.length') &&
    grantText.includes('rawOrigins.some((origin)=>!addedOrigins.includes(origin))') &&
    grantText.includes("!['armed','prompt_intent_tombstone','prompt_tombstone'].includes(handoff.status)") &&
    grantText.includes('!handoff.promptIntent') &&
    grantText.includes('consttemporaryOrigins=requestedOrigins.filter((origin)=>!preexistingOrigins.has(origin))') &&
    grantText.includes(
      "if(!jsonEquivalent(addedOrigins,canonicalizeHostPermissionOrigins(temporaryOrigins))){return{promptGrantObserved:false,reason:'permission_event_not_exact_complete_reviewed_set'};}"
    ) &&
    grantText.includes('constobservedOrigins=addedOrigins') &&
    grantText.includes('complete:true') &&
    grantText.includes('awaitstorageSession.set({[CLEANUP_REVIEW_STORAGE_KEY]:retainedRecord})') &&
    grantText.includes('promptGrantComplete:promptGrant.complete')
  );
  if (!exactGrantObservation) {
    findings.push(
      'src/background/cleanup-preflight.js: only durable exact post-begin permissions.onAdded observations may build the complete promptGrant proof'
    );
  }

  const compactPreflight = preflightSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\s+/g, '');
  const exactConfirmationGrace = Boolean(
    compactPreflight.includes('CLEANUP_PERMISSION_PROMPT_CONFIRM_GRACE_MS=30*1000') &&
    compactPreflight.includes("status:'prompt_intent_tombstone'") &&
    compactPreflight.includes('cleanupReviewPromptIntentMayStillConfirm(record,now)') &&
    compactPreflight.includes("createPromptIntentTombstoneRecord(record,Number(now),'cleanup_review_expired')") &&
    compactPreflight.includes("record.approvalHandoff.status==='prompt_intent_tombstone'") &&
    compactPreflight.includes('createPromptTombstoneRecord(') &&
    compactPreflight.includes("['armed','prompt_intent_tombstone'].includes(record.approvalHandoff.status)") &&
    compactPreflight.includes('!record.approvalHandoff.promptIntent||record.approvalHandoff.promptInvocation')
  );
  if (!exactConfirmationGrace) {
    findings.push(
      'src/background/cleanup-preflight.js: unconfirmed intent must remain non-runnable during the 30-second confirmation grace, tombstone on expiry/invalidation, and become prompt_tombstone only after authenticated confirmation'
    );
  }

  const readyFunction = findNamedFunction(sourceFile, 'getReadyArmedCleanupReview');
  const readyText = compactNodeText(readyFunction?.body, sourceFile);
  const consumeFunction = findNamedFunction(sourceFile, 'consumeCleanupReviewRequest');
  const consumeText = compactNodeText(consumeFunction?.body, sourceFile);
  if (
    !readyText.includes(
      "handoff.status!=='armed'||!handoff.promptInvocation||handoff.promptGrant?.complete!==true||handoff.promptGrantOutcome?.granted!==true||handoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent!==true"
    ) ||
    !consumeText.includes(
      "record.approvalHandoff.status!=='armed'||!record.approvalHandoff.promptInvocation||record.approvalHandoff.promptGrant?.complete!==true||record.approvalHandoff.promptGrantOutcome?.granted!==true||record.approvalHandoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent!==true"
    )
  ) {
    findings.push(
      'src/background/cleanup-preflight.js: readiness and atomic consumption must require invocation, complete event proof, literal-true popup outcome, and pre-request absence'
    );
  }
}

function validateWorkerPromptInvocationRoute(source, findings) {
  const beginRoute = sourceRange(
    source,
    'case MESSAGE_TYPES.beginCleanupPermissionHandoff:',
    'case MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation:'
  );
  const invocationRoute = sourceRange(
    source,
    'case MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation:',
    'case MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant:'
  );
  const grantRoute = sourceRange(
    source,
    'case MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant:',
    'case MESSAGE_TYPES.resumeCleanupPermissionHandoff:'
  );
  const resumeRoute = sourceRange(
    source,
    'case MESSAGE_TYPES.resumeCleanupPermissionHandoff:',
    'case MESSAGE_TYPES.settleCleanupPermissionHandoff:'
  );
  const retiredRoute = sourceRange(
    source,
    'case MESSAGE_TYPES.beginCleanupPermissionPrompt:',
    'case MESSAGE_TYPES.runDeepClean:'
  );
  const permissionAddedRoute = sourceRange(
    source,
    'chrome.permissions?.onAdded?.addListener?.(',
    'chrome.permissions?.onRemoved?.addListener?.('
  );
  const compactBegin = beginRoute.replaceAll(/\s/g, '');
  const compactInvocation = invocationRoute.replaceAll(/\s/g, '');
  const compactGrant = grantRoute.replaceAll(/\s/g, '');
  const exactNonRunnableBegin = Boolean(
    compactBegin.includes('awaitserializeCleanupReviewStateMutation(async()=>{') &&
    compactBegin.includes('requireCapability:true,requireUnusedCapability:true') &&
    compactBegin.includes("status:'used'") &&
    compactBegin.indexOf('awaitchrome.storage.session.set(') <
      compactBegin.indexOf('awaitrecordCleanupPermissionPromptIntent(') &&
    compactBegin.includes('queueAlarmAt(ALARMS.reviewPromptConfirmation,intent.confirmationDeadlineAt)')
  );
  const exactInvocation = Boolean(
    compactInvocation.includes('constinvocation=awaitserializeCleanupReviewStateMutation(async()=>{') &&
    compactInvocation.includes('requireCapability:true,requireUsedCapability:true') &&
    compactInvocation.includes('recordCleanupPermissionPromptInvocation(') &&
    compactInvocation.includes('queueAlarmClear(ALARMS.reviewPromptConfirmation)') &&
    compactInvocation.includes('returninvocation;') &&
    !compactInvocation.includes('queueArmedCleanupResume')
  );
  const exactGrant = Boolean(
    compactGrant.includes('constoutcome=awaitserializeCleanupReviewStateMutation(async()=>{') &&
    compactGrant.includes('requireCapability:true,requireUsedCapability:true') &&
    compactGrant.includes('recordCleanupPermissionGrantOutcome(') &&
    compactGrant.includes('preRequestTemporaryOriginsAbsent:payload.preRequestTemporaryOriginsAbsent') &&
    compactGrant.includes("awaitqueueArmedCleanupResume('handoff-permission-grant-confirmed',payload.handoffNonce)") &&
    !compactGrant.includes('clearCleanupPermissionHandoff(payload.handoffNonce)')
  );
  if (!exactNonRunnableBegin || !exactInvocation || !exactGrant) {
    findings.push(
      'src/background/service-worker.js: persistent handoff begin must consume capability before durable intent, invocation must persist without re-drive, and only authenticated literal-true outcome may re-drive its nonce'
    );
  }
  if (
    !resumeRoute.includes('requireCapability: true') ||
    !resumeRoute.includes('requireUsedCapability: true') ||
    !resumeRoute.includes('allowAdmittedJob: true') ||
    /recordCleanupPermission(?:PromptIntent|PromptInvocation|GrantOutcome)/.test(resumeRoute) ||
    !permissionAddedRoute.includes('recordCleanupPermissionGrantObservation(addedPermissions') ||
    permissionAddedRoute.includes('recordCleanupPermissionGrantOutcome') ||
    !retiredRoute.includes('Popup target-access continuation is retired')
  ) {
    findings.push(
      'src/background/service-worker.js: persistent resume and permissions.onAdded may not synthesize prompt proof, and every retired popup continuation must fail closed'
    );
  }

  const resumeFunction = sourceRange(
    source,
    'async function resumeArmedCleanupAfterGrant(',
    'async function getRunningArmedCleanupResult('
  );
  const lateSettlement = sourceRange(
    source,
    'async function reconcileLateCleanupPermissionGrant(',
    'function classifyResponseError('
  );
  const compactLateSettlement = lateSettlement.replaceAll(/\s/g, '');
  const tombstoneSettlement = sourceRange(
    source,
    'async function settleOwnedCleanupPromptTombstone(',
    'async function settleCleanupPromptAtBrowserSessionBoundary('
  );
  const ordinaryMaintenanceSettlement = sourceRange(
    source,
    'const grantedPromptTombstoneSettled =',
    'let preservedCleanupReview ='
  );
  const browserSessionSettlement = sourceRange(
    source,
    'async function settleCleanupPromptAtBrowserSessionBoundary(',
    'async function settleCleanupPermissionPromptByLeaseId('
  );
  if (
    !resumeFunction.includes('const retryDelays = [0, 40, 120, 240, 480]') ||
    !resumeFunction.includes('const latePromptSettlement = await reconcileLateCleanupPermissionGrant') ||
    !resumeFunction.includes('approvalHandoffPending: true') ||
    resumeFunction.includes('discardUninvokedPermissionLease') ||
    resumeFunction.includes('releaseTemporaryHostPermissions') ||
    !compactLateSettlement.includes("if(initialHandoff?.status!=='prompt_tombstone'&&!expiredFinalClick)returnnull;") ||
    !lateSettlement.includes('Date.now() > initial.expiresAtMs') ||
    lateSettlement.includes('promptGrantOutcome?.granted === true') ||
    lateSettlement.includes('promptGrant?.complete !== true') ||
    !lateSettlement.includes('allowUnobservedPromptDiscard: false') ||
    !lateSettlement.includes('requireExactGrant: true') ||
    !ordinaryMaintenanceSettlement.includes('allowUnobservedPromptDiscard: false') ||
    !ordinaryMaintenanceSettlement.includes('requireExactGrant: true') ||
    !browserSessionSettlement.includes('allowUnobservedPromptDiscard: true') ||
    !browserSessionSettlement.includes('requireExactGrant: false') ||
    !tombstoneSettlement.includes(
      '(review.approvalHandoff.promptGrant?.complete !== true ||\n      review.approvalHandoff.promptGrantOutcome?.granted !== true ||\n      review.approvalHandoff.promptGrantOutcome?.preRequestTemporaryOriginsAbsent !== true) &&\n    options.allowUnobservedPromptDiscard !== true'
    )
  ) {
    findings.push(
      'src/background/service-worker.js: ordinary expiry and late-grant recovery must retain an unobserved invoked prompt; only exact terminal handoff settlement or a real browser-session boundary may discard its bookkeeping'
    );
  }
}

function validatePersistentPermissionHandoffBinding(source, findings) {
  const open = sourceRange(
    source,
    'async function openCleanupPermissionHandoff(',
    'async function claimCleanupPermissionHandoff('
  );
  const claim = sourceRange(
    source,
    'async function claimCleanupPermissionHandoff(',
    'async function assertCleanupPermissionHandoffBinding('
  );
  const binding = sourceRange(
    source,
    'async function assertCleanupPermissionHandoffBinding(',
    'async function readCleanupPermissionHandoff('
  );
  const normalization = sourceRange(
    source,
    'function normalizeCleanupPermissionHandoffRecord(',
    'async function inspectExactPermissionHandoffSender('
  );
  const sender = sourceRange(
    source,
    'async function inspectExactPermissionHandoffSender(',
    'async function inspectExactPermissionHandoffRuntimeContext('
  );
  const runtimeContext = sourceRange(
    source,
    'async function inspectExactPermissionHandoffRuntimeContext(',
    'function createCleanupPermissionHandoffCapability('
  );
  const capability = sourceRange(
    source,
    'function createCleanupPermissionHandoffCapability(',
    'async function clearCleanupPermissionHandoff('
  );
  const compactOpen = open.replaceAll(/\s/g, '').replaceAll('"', "'");
  const compactClaim = claim.replaceAll(/\s/g, '');
  const compactBinding = binding.replaceAll(/\s/g, '');
  const compactNormalization = normalization.replaceAll(/\s/g, '');
  const compactSender = sender.replaceAll(/\s/g, '');
  const compactRuntimeContext = runtimeContext.replaceAll(/\s/g, '').replaceAll('"', "'");
  const compactCapability = capability.replaceAll(/\s/g, '');
  const persistAt = compactOpen.indexOf(
    'awaitchrome.storage.session.set({[CLEANUP_PERMISSION_HANDOFF_STORAGE_KEY]:record})'
  );
  const navigateAt = compactOpen.indexOf(
    "awaitchrome.tabs.update(tab.id,{url:chrome.runtime.getURL('handoff/handoff.html'),active:true})"
  );

  const exactWorkerOwnedTab = Boolean(
    compactOpen.includes('constreviewedWindowId=review.approvalHandoff.sourceWindowId') &&
    compactOpen.includes('review.approvalHandoff.sourceIncognito') &&
    compactOpen.includes("chrome.tabs.create({windowId:reviewedWindowId,url:'about:blank',active:true})") &&
    compactOpen.includes('tab.incognito!==false') &&
    compactOpen.includes('tab.windowId!==reviewedWindowId') &&
    persistAt >= 0 &&
    persistAt < navigateAt &&
    compactOpen.includes("if(existing.status!=='opening'){awaitinspectExactPermissionHandoffRuntimeContext(")
  );
  const exactClaimAndCapability = Boolean(
    compactClaim.includes("record.status!=='opening'") &&
    compactClaim.includes('awaitinspectExactPermissionHandoffSender(sender,record,') &&
    compactClaim.includes('consthandoffCapability=createCleanupPermissionHandoffCapability()') &&
    compactClaim.includes('capabilityDigest=awaitdigestCleanupPopupPreparationCapability(handoffCapability)') &&
    compactClaim.includes('constcontextId=senderBinding.contextId') &&
    compactClaim.includes('documentId:senderBinding.documentId') &&
    compactClaim.includes('[CLEANUP_PERMISSION_HANDOFF_STORAGE_KEY]:claimedRecord') &&
    compactClaim.includes('handoffCapability,') &&
    compactNormalization.includes("!['opening','claimed','used'].includes(value.status)") &&
    compactNormalization.includes('value.documentId==null?null:normalizeRuntimePopupContextId(value.documentId)') &&
    compactNormalization.includes('!/^[a-f0-9]{64}$/.test(capabilityDigest)') &&
    compactCapability.includes('constbytes=newUint8Array(32)') &&
    compactCapability.includes('globalThis.crypto.getRandomValues(bytes)')
  );
  const exactAuthorityBinding = Boolean(
    compactBinding.includes('awaitinspectExactPermissionHandoffSender(sender,record,') &&
    compactBinding.includes('record.contextId!==senderBinding.contextId') &&
    compactBinding.includes(
      'record.documentId&&senderBinding.documentId&&record.documentId!==senderBinding.documentId'
    ) &&
    compactBinding.includes('options.requireUnusedCapability===true&&record.capabilityUsedAtMs!==null') &&
    compactBinding.includes('options.requireUsedCapability===true&&!Number.isSafeInteger(record.capabilityUsedAtMs)') &&
    compactBinding.includes(
      'constactualDigest=awaitdigestCleanupPopupPreparationCapability(payload.handoffCapability)'
    ) &&
    compactBinding.includes('!constantTimeHexEqual(record.capabilityDigest,actualDigest)') &&
    compactBinding.includes('review.approvalHandoff.promptContextId!==record.contextId') &&
    compactBinding.includes('options.allowAdmittedJob===true')
  );
  const exactSender = Boolean(
    compactSender.includes('sender?.id!==chrome.runtime.id') &&
    compactSender.includes('sender?.tab?.id!==record.tabId') &&
    compactSender.includes('sender?.tab?.incognito!==false') &&
    compactSender.includes('!Number.isInteger(sender?.tab?.windowId)') &&
    compactSender.includes('sender.tab.windowId!==record.windowId') &&
    compactSender.includes('sender?.frameId!==0') &&
    compactSender.includes('(sender?.origin!=null&&sender.origin!==extensionOrigin)') &&
    compactSender.includes('reportedUrls.length===0') &&
    compactSender.includes('reportedUrls.some((value)=>value!==handoffUrl)') &&
    compactSender.includes('sender?.documentId==null?null:normalizeRuntimePopupContextId(sender.documentId)') &&
    compactSender.includes('(sender?.documentId!=null&&!senderDocumentId)') &&
    compactSender.includes('(record.documentId&&senderDocumentId&&record.documentId!==senderDocumentId)')
  );
  const exactRuntimeContext = Boolean(
    compactRuntimeContext.includes(
      "chrome.runtime.getContexts({contextTypes:['TAB'],tabIds:[record.tabId],documentUrls:[handoffUrl],frameIds:[0],incognito:false})"
    ) &&
    compactRuntimeContext.includes('!Array.isArray(contexts)||contexts.length!==1') &&
    compactRuntimeContext.includes("context.contextType!=='TAB'") &&
    compactRuntimeContext.includes('context.documentUrl!==handoffUrl') &&
    compactRuntimeContext.includes(
      "(context?.documentOrigin!=null&&(typeofcontext.documentOrigin!=='string'||context.documentOrigin!==extensionOrigin))"
    ) &&
    compactRuntimeContext.includes('context.tabId!==record.tabId') &&
    compactRuntimeContext.includes('context.frameId!==0') &&
    compactRuntimeContext.includes('context.incognito!==false') &&
    compactRuntimeContext.includes('!Number.isInteger(context.windowId)') &&
    compactRuntimeContext.includes('context.windowId!==expectedWindowId') &&
    compactRuntimeContext.includes('(context?.documentId!=null&&!contextDocumentId)') &&
    compactRuntimeContext.includes('(record.contextId&&record.contextId!==contextId)')
  );

  if (
    !exactWorkerOwnedTab ||
    !exactClaimAndCapability ||
    !exactAuthorityBinding ||
    !exactSender ||
    !exactRuntimeContext
  ) {
    findings.push(
      'src/background/service-worker.js: the persistent handoff must be a worker-created normal tab in the reviewed window, bind a one-use digest-only capability to one exact runtime TAB context, treat documentId/origin as optional cross-checks, and reject every sender/context mismatch'
    );
  }
}

function validateInvalidReviewNeutralizationBoundary(preflightSource, leaseSource, workerSource, findings) {
  const discardReview = sourceRange(
    preflightSource,
    'async function discardInvalidCleanupReview(',
    'async function discardUninvokedCleanupReviewRecord('
  );
  const discardLease = sourceRange(
    leaseSource,
    'export async function discardInvalidReviewPermissionLease(',
    'export async function discardPermissionLeaseAfterObservedRemoval('
  );
  const installedMaintenance = sourceRange(
    workerSource,
    'async function runInstalledMaintenance(',
    'async function requestInstalledLifecycleMaintenance('
  );
  const lifecycleMaintenance = sourceRange(
    workerSource,
    'async function runMaintenanceCycle(',
    'async function inspectLiveCleanupReview('
  );
  const pendingHelper = sourceRange(
    workerSource,
    'function invalidReviewNeutralizationIsPending(',
    'function permissionLeaseMatchesLiveCleanupReview('
  );
  const compactReview = discardReview.replaceAll(/\s/g, '');
  const compactLease = discardLease
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replaceAll(/\s/g, '');
  const compactInstalled = installedMaintenance.replaceAll(/\s/g, '');
  const compactLifecycle = lifecycleMaintenance.replaceAll(/\s/g, '');
  const compactPending = pendingHelper.replaceAll(/\s/g, '');
  const neutralizeAt = compactReview.indexOf('awaitdiscardInvalidReviewPermissionLease(storageLocal)');
  const sessionRemoveAt = compactReview.indexOf('awaitstorageSession.remove(CLEANUP_REVIEW_STORAGE_KEY)');
  const leaseRemoveAt = compactLease.indexOf('awaitstorageLocal.remove(STORAGE_KEYS.permissionLease)');
  const leasePostReadAt = compactLease.indexOf(
    'postRemoval=awaitstorageLocal.get([STORAGE_KEYS.permissionLease])',
    leaseRemoveAt
  );

  const exactReviewOrder = Boolean(
    neutralizeAt >= 0 &&
    neutralizeAt < sessionRemoveAt &&
    compactReview.includes('neutralized.recordRetained===true&&neutralized.admittedCleanupRetained!==true') &&
    compactReview.includes('postRemoval=awaitstorageSession.get([CLEANUP_REVIEW_STORAGE_KEY])') &&
    compactReview.includes("reason:'invalid_review_marker_removal_unproven'")
  );
  const exactLeaseNeutralization = Boolean(
    compactLease.includes("if(lease?.ownershipProof==='admitted_cleanup'){") &&
    compactLease.includes('admittedCleanupRetained:true') &&
    leaseRemoveAt >= 0 &&
    leaseRemoveAt < leasePostReadAt &&
    compactLease.includes('postRemoval?.[STORAGE_KEYS.permissionLease]!=null') &&
    compactLease.includes("reason:'invalid_review_lease_neutralization_unproven'") &&
    compactLease.includes("reason:'invalid_review_lease_discarded'") &&
    !compactLease.includes('permissions.remove') &&
    !compactLease.includes('releaseHostPermissions')
  );
  const exactMaintenanceShortCircuit = Boolean(
    compactInstalled.includes('invalidReviewNeutralizationIsPending(cleanupReviewRecovery)?') &&
    compactInstalled.includes('createInvalidReviewNeutralizationPendingResult(cleanupReviewRecovery,') &&
    compactLifecycle.includes('invalidReviewNeutralizationIsPending(cleanupReviewExpiration)?') &&
    compactLifecycle.includes('createInvalidReviewNeutralizationPendingResult(cleanupReviewExpiration,') &&
    compactPending.includes('cleanupReviewRecovery?.invalidReviewDiscarded===true') &&
    compactPending.includes('cleanup?.recordRetained===true') &&
    compactPending.includes('cleanup?.admittedCleanupRetained!==true') &&
    compactPending.includes('invalidReviewNeutralizationPending:true')
  );
  if (!exactReviewOrder || !exactLeaseNeutralization || !exactMaintenanceShortCircuit) {
    findings.push(
      'runtime: every invalid cleanup review must neutralize non-admitted lease bookkeeping before session removal, preserve admitted cleanup recovery, prove storage commits, and block maintenance/startup permission recovery while neutralization is uncertain'
    );
  }
}

function _validateLegacyWorkerPromptInvocationRoute(source, findings) {
  const beginRoute = sourceRange(
    source,
    'case MESSAGE_TYPES.beginCleanupPermissionPrompt:',
    'case MESSAGE_TYPES.confirmCleanupPermissionPromptInvocation:'
  );
  const confirmRoute = sourceRange(
    source,
    'case MESSAGE_TYPES.confirmCleanupPermissionPromptInvocation:',
    'case MESSAGE_TYPES.confirmCleanupPermissionGrantOutcome:'
  );
  const outcomeRoute = sourceRange(
    source,
    'case MESSAGE_TYPES.confirmCleanupPermissionGrantOutcome:',
    'case MESSAGE_TYPES.resumeArmedCleanup:'
  );
  const resumeRoute = sourceRange(source, 'case MESSAGE_TYPES.resumeArmedCleanup:', 'case MESSAGE_TYPES.runDeepClean:');
  const permissionAddedRoute = sourceRange(
    source,
    'chrome.permissions?.onAdded?.addListener?.(',
    'chrome.runtime.onMessage.addListener('
  );
  const exactNonRunnableBegin = Boolean(
    beginRoute.includes("assertExactPopupSender(sender, 'begin a Chrome target-access request')") &&
    /const\s+intent\s*=\s*await\s+serializeCleanupReviewStateMutation\(\(\)\s*=>\s*recordCleanupPermissionPromptIntent\(payload,/.test(
      beginRoute
    ) &&
    beginRoute.includes('queueAlarmAt(ALARMS.reviewPromptConfirmation, intent.confirmationDeadlineAt)') &&
    beginRoute.includes('return intent;') &&
    !beginRoute.includes('ALARMS.reviewExpiry') &&
    !beginRoute.includes('recordCleanupPermissionPromptInvocation') &&
    !beginRoute.includes('queueArmedCleanupResume')
  );
  const serializedDurableConfirm =
    /const\s+invocation\s*=\s*await\s+serializeCleanupReviewStateMutation\(\(\)\s*=>\s*recordCleanupPermissionPromptInvocation\(payload,/.test(
      confirmRoute
    ) &&
    confirmRoute.includes("assertExactPopupSender(sender, 'confirm an accepted Chrome target-access request')") &&
    confirmRoute.includes('queueAlarmClear(ALARMS.reviewPromptConfirmation)') &&
    confirmRoute.includes('return invocation;') &&
    !confirmRoute.includes('ALARMS.reviewExpiry') &&
    !confirmRoute.includes('queueArmedCleanupResume');
  const serializedDurableGrantOutcome = Boolean(
    outcomeRoute.includes("assertExactPopupSender(sender, 'confirm Chrome granted the requested target access')") &&
    /const\s+outcome\s*=\s*await\s+serializeCleanupReviewStateMutation\(\(\)\s*=>\s*recordCleanupPermissionGrantOutcome\(payload,/.test(
      outcomeRoute
    ) &&
    /const\s+result\s*=\s*await\s+queueArmedCleanupResume\(['"]popup-permission-grant-confirmed['"],\s*payload\.handoffNonce\)/.test(
      outcomeRoute
    ) &&
    outcomeRoute.includes('return { ...outcome, ...result };')
  );
  const separateConfirmationAlarm = Boolean(
    /reviewExpiry:\s*['"]sitewipe\.reviewExpiry['"]/.test(source) &&
    /reviewPromptConfirmation:\s*['"]sitewipe\.reviewPromptConfirmation['"]/.test(source) &&
    source.includes('ALARMS.reviewPromptConfirmation')
  );
  if (
    !exactNonRunnableBegin ||
    !serializedDurableConfirm ||
    !serializedDurableGrantOutcome ||
    !separateConfirmationAlarm
  ) {
    findings.push(
      'src/background/service-worker.js: begin must persist intent and its separate alarm, invocation confirm must persist without re-drive, and only durable authenticated grant outcome may re-drive its nonce'
    );
  }
  if (
    !resumeRoute ||
    resumeRoute.includes('recordCleanupPermissionPromptIntent') ||
    resumeRoute.includes('recordCleanupPermissionPromptInvocation') ||
    resumeRoute.includes('recordCleanupPermissionGrantOutcome') ||
    /prompt(?:Intent|Invocation|GrantOutcome)\s*(?:=|:)/.test(resumeRoute) ||
    !resumeRoute.includes('review.approvalHandoff?.promptGrantOutcome?.granted !== true') ||
    !resumeRoute.includes('review.approvalHandoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true') ||
    !permissionAddedRoute ||
    !permissionAddedRoute.includes('recordCleanupPermissionGrantObservation(addedPermissions') ||
    !permissionAddedRoute.includes("queueArmedCleanupResume('permissions-added', observation?.handoffNonce || null)") ||
    permissionAddedRoute.includes('recordCleanupPermissionPromptIntent') ||
    permissionAddedRoute.includes('recordCleanupPermissionPromptInvocation') ||
    permissionAddedRoute.includes('recordCleanupPermissionGrantOutcome')
  ) {
    findings.push(
      'src/background/service-worker.js: resume and permissions.onAdded may not synthesize promptGrantOutcome; outcome and exact event proof must remain independent'
    );
  }
  const resumeFunction = sourceRange(
    source,
    'async function resumeArmedCleanupAfterGrant(',
    'async function getRunningArmedCleanupResult('
  );
  const lateSettlement = sourceRange(
    source,
    'async function reconcileLateCleanupPermissionGrant(',
    'function classifyResponseError('
  );
  const compactLateSettlement = lateSettlement.replaceAll(/\s/g, '');
  const tombstoneSettlement = sourceRange(
    source,
    'async function settleOwnedCleanupPromptTombstone(',
    'async function settleCleanupPromptAtBrowserSessionBoundary('
  );
  const ordinaryMaintenanceSettlement = sourceRange(
    source,
    'const grantedPromptTombstoneSettled =',
    'let preservedCleanupReview ='
  );
  const browserSessionSettlement = sourceRange(
    source,
    'async function settleCleanupPromptAtBrowserSessionBoundary(',
    'async function settleCleanupPermissionPromptByLeaseId('
  );
  if (
    !resumeFunction.includes('const retryDelays = [0, 40, 120, 240, 480]') ||
    !resumeFunction.includes('const latePromptSettlement = await reconcileLateCleanupPermissionGrant') ||
    !resumeFunction.includes('approvalHandoffPending: true') ||
    resumeFunction.includes('discardUninvokedPermissionLease') ||
    resumeFunction.includes('releaseTemporaryHostPermissions') ||
    !compactLateSettlement.includes("if(initialHandoff?.status!=='prompt_tombstone'&&!expiredFinalClick)returnnull;") ||
    !lateSettlement.includes('Date.now() > initial.expiresAtMs') ||
    lateSettlement.includes('promptGrantOutcome?.granted === true') ||
    lateSettlement.includes('promptGrant?.complete !== true') ||
    !lateSettlement.includes('allowUnobservedPromptDiscard: false') ||
    !lateSettlement.includes('requireExactGrant: true') ||
    !ordinaryMaintenanceSettlement.includes('allowUnobservedPromptDiscard: false') ||
    !ordinaryMaintenanceSettlement.includes('requireExactGrant: true') ||
    !browserSessionSettlement.includes('allowUnobservedPromptDiscard: true') ||
    !browserSessionSettlement.includes('requireExactGrant: false') ||
    !tombstoneSettlement.includes(
      '(review.approvalHandoff.promptGrant?.complete !== true ||\n      review.approvalHandoff.promptGrantOutcome?.granted !== true ||\n      review.approvalHandoff.promptGrantOutcome?.preRequestTemporaryOriginsAbsent !== true) &&\n    options.allowUnobservedPromptDiscard !== true'
    )
  ) {
    findings.push(
      'src/background/service-worker.js: ordinary expiry and late-grant recovery must retain an unobserved invoked prompt; only exact terminal handoff settlement or a real browser-session boundary may discard its bookkeeping'
    );
  }
}

function validateUninvokedPermissionPreservation(preflightSource, leaseSource, findings) {
  const releaseFunction = sourceRange(
    preflightSource,
    'async function releaseTemporaryReviewAccess(',
    'function getTemporaryReviewHostPermissionOrigins('
  );
  const promptMaySettleFunction = sourceRange(
    preflightSource,
    'function cleanupReviewPromptMayStillSettle(',
    'function getPendingPromptContextId('
  );
  const stageFunction = sourceRange(
    preflightSource,
    'export async function stageCleanupReviewApprovalRequest(',
    'export async function armCleanupReviewApprovalRequest('
  );
  const discardReviewFunction = sourceRange(
    preflightSource,
    'async function discardUninvokedCleanupReviewRecord(',
    'function normalizeExactStringArray('
  );
  const discardFunction = sourceRange(
    leaseSource,
    'export async function discardUninvokedPermissionLease(',
    'export async function reconcilePermissionLease('
  );
  const discardCode = discardFunction.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
  const uninvokedIsDiscardOnly = Boolean(
    discardFunction &&
    discardFunction.includes('storageLocal.remove(STORAGE_KEYS.permissionLease)') &&
    discardFunction.includes('permissionsPreserved: true') &&
    !/(?:permissions\.remove|releaseHostPermissions|reconcilePermissionLease)/.test(discardCode)
  );
  const compactStageFunction = stageFunction.replaceAll(/\s/g, '');
  const compactDiscardReviewFunction = discardReviewFunction.replaceAll(/\s/g, '');
  const cleanupNeedsInvocationOrTombstone = Boolean(
    releaseFunction.includes("record.approvalHandoff?.status !== 'prompt_tombstone' &&") &&
    releaseFunction.includes('!record.approvalHandoff?.promptInvocation') &&
    releaseFunction.includes('record.approvalHandoff?.promptGrant?.complete !== true') &&
    releaseFunction.includes('record.approvalHandoff?.promptGrantOutcome?.granted !== true') &&
    releaseFunction.includes('record.approvalHandoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true') &&
    releaseFunction.includes('discardUninvokedPermissionLease') &&
    promptMaySettleFunction.includes("handoff?.status === 'prompt_tombstone'") &&
    promptMaySettleFunction.includes('Boolean(handoff.promptInvocation)') &&
    compactStageFunction.includes('awaitdiscardUninvokedCleanupReviewRecord(record,dependencies)') &&
    compactDiscardReviewFunction.includes('awaitdiscardUninvokedPermissionLease(storageLocal,record.permissionLeaseId)')
  );
  if (!uninvokedIsDiscardOnly || !cleanupNeedsInvocationOrTombstone) {
    findings.push(
      'permission recovery: an uninvoked or manual grant must never run cleanup or be removed; only its unused lease bookkeeping may be discarded'
    );
  }
}

function validateDurablePermissionOwnershipProvenance(preflightSource, leaseSource, workerSource, findings) {
  const compactLease = leaseSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const compactPreflight = preflightSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const compactWorker = workerSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const promptOwnership = sourceRange(
    leaseSource,
    'export async function markPermissionLeasePromptGrantOwned(',
    'export async function revokePermissionLeaseOwnership('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const activeOwnership = sourceRange(
    leaseSource,
    'export async function markPermissionLeaseActive(',
    'export async function markPermissionLeasePromptGrantOwned('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const revokeOwnership = sourceRange(
    leaseSource,
    'export async function revokePermissionLeaseOwnership(',
    'function normalizePermissionLeaseBinding('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const reconcileLease = sourceRange(
    leaseSource,
    'export async function reconcilePermissionLease(',
    'async function retainLease('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const retainLease = sourceRange(leaseSource, 'async function retainLease(', 'async function queryGrantedOrigins(')
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const ownershipPersist = sourceRange(
    preflightSource,
    'async function persistCleanupPermissionLeaseOwnership(',
    'async function inspectLeaseOwnedPromptGrantTransition('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const grantObservation = sourceRange(
    preflightSource,
    'export async function recordCleanupPermissionGrantObservation(',
    'export async function recordCleanupPermissionGrantOutcome('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const grantOutcome = sourceRange(
    preflightSource,
    'export async function recordCleanupPermissionGrantOutcome(',
    'export async function discardCleanupPermissionPromptWithoutInvocation('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const onAddedRoute = sourceRange(
    workerSource,
    'chrome.permissions?.onAdded?.addListener?.(',
    'chrome.permissions?.onRemoved?.addListener?.('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const onRemovedRoute = sourceRange(
    workerSource,
    'chrome.permissions?.onRemoved?.addListener?.(',
    'chrome.runtime.onMessage.addListener('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const removalEventState = sourceRange(
    workerSource,
    'function getPermissionEventOrigins(',
    'async function attemptRemovedPermissionInvalidation('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const reviewRemovalInvalidation = sourceRange(
    workerSource,
    'async function invalidateRemovedCleanupReviewAuthority(',
    'async function invalidateRemovedPermissionLeaseAuthority('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const leaseRemovalInvalidation = sourceRange(
    workerSource,
    'async function invalidateRemovedPermissionLeaseAuthority(',
    'async function invalidateRemovedCleanupPermissionOwnership('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const combinedRemovalInvalidation = sourceRange(
    workerSource,
    'async function invalidateRemovedCleanupPermissionOwnership(',
    'function getPendingCleanupApprovalPromptContextId('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const liveReviewPermissionBinding = sourceRange(
    workerSource,
    'function permissionLeaseMatchesLiveCleanupReview(',
    'function stringArraysEqual('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const strictPermissionInspection = sourceRange(
    workerSource,
    'async function containsHostPermissionsStrict(',
    'async function hasNamedPermission('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const restartLeaseRecovery = sourceRange(
    workerSource,
    'async function recoverTemporaryPermissionLease(',
    'async function inspectPermissionLeaseStatus('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");
  const temporaryPermissionRelease = sourceRange(
    workerSource,
    'async function releaseTemporaryHostPermissions(',
    'async function getActiveTabTarget('
  )
    .replace(/\s+/g, '')
    .replaceAll('"', "'");

  const leaseSchemaAndTransitionsAreBound = Boolean(
    /export\s+const\s+PERMISSION_LEASE_SCHEMA_VERSION\s*=\s*3\s*;/.test(leaseSource) &&
    compactLease.includes('ownershipProof:null,ownershipRevokedAt:null') &&
    compactLease.includes("['reviewed_prompt_grant','admitted_cleanup','revoked'].includes(value.ownershipProof)") &&
    compactLease.includes("(ownershipProof==='revoked')!==Boolean(ownershipRevokedAt)") &&
    compactLease.includes(
      "value.status==='prompt_pending'&&![null,'reviewed_prompt_grant','revoked'].includes(ownershipProof)"
    ) &&
    compactLease.includes(
      "value.status==='active_cleanup'&&!['admitted_cleanup','revoked'].includes(ownershipProof)"
    ) &&
    promptOwnership.includes("lease.status!=='prompt_pending'") &&
    promptOwnership.includes("![null,'reviewed_prompt_grant'].includes(lease.ownershipProof)") &&
    promptOwnership.includes("ownershipProof:'reviewed_prompt_grant'") &&
    activeOwnership.includes("lease.status!=='prompt_pending'") &&
    activeOwnership.includes("lease.ownershipProof!=='reviewed_prompt_grant'") &&
    activeOwnership.includes("status:'active_cleanup'") &&
    activeOwnership.includes("ownershipProof:'admitted_cleanup'") &&
    retainLease.includes("...lease,status:'release_pending'") &&
    !retainLease.includes('ownershipProof:null')
  );
  if (!leaseSchemaAndTransitionsAreBound) {
    findings.push(
      'src/background/permission-leases.js: schema-3 ownership provenance must progress null to reviewed_prompt_grant to admitted_cleanup, survive release_pending, and represent revocation explicitly'
    );
  }

  const completeProofOwnsOnlyAfterSessionPersistence = Boolean(
    ownershipPersist.includes('!handoff?.promptInvocation') &&
    ownershipPersist.includes('handoff.promptGrant?.complete!==true') &&
    ownershipPersist.includes('handoff.promptGrantOutcome?.granted!==true') &&
    ownershipPersist.includes('handoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent!==true') &&
    ownershipPersist.includes('awaitmarkPermissionLeasePromptGrantOwned(') &&
    grantObservation.includes('awaitstorageSession.set({[CLEANUP_REVIEW_STORAGE_KEY]:retainedRecord})') &&
    grantObservation.indexOf('awaitpersistCleanupPermissionLeaseOwnership(retainedRecord,dependencies)') >
      grantObservation.indexOf('awaitstorageSession.set({[CLEANUP_REVIEW_STORAGE_KEY]:retainedRecord})') &&
    grantOutcome.includes('awaitstorageSession.set({[CLEANUP_REVIEW_STORAGE_KEY]:retainedRecord})') &&
    grantOutcome.indexOf('awaitpersistCleanupPermissionLeaseOwnership(retainedRecord,dependencies)') >
      grantOutcome.indexOf('awaitstorageSession.set({[CLEANUP_REVIEW_STORAGE_KEY]:retainedRecord})') &&
    compactPreflight.includes("lease.ownershipProof!=='reviewed_prompt_grant'")
  );
  if (!completeProofOwnsOnlyAfterSessionPersistence) {
    findings.push(
      'src/background/cleanup-preflight.js: reviewed_prompt_grant ownership must be persisted only after the durable session record contains invocation, exact event, literal-true outcome, and pre-request absence'
    );
  }

  const revokedOrProoflessAccessIsPreserved = Boolean(
    revokeOwnership.includes('lease.temporaryOrigins.some((origin)=>removed.has(origin))') &&
    revokeOwnership.includes('lease.ownershipProof==null') &&
    revokeOwnership.includes("ownershipProof:'revoked'") &&
    revokeOwnership.includes('ownershipRevokedAt:newDate(revokedAtMs).toISOString()') &&
    reconcileLease.includes("if(lease.ownershipProof==='revoked')") &&
    reconcileLease.includes("reason:'revoked_ownership_discarded'") &&
    reconcileLease.includes('permissionsPreserved:true') &&
    (reconcileLease.includes('if(lease.ownershipProof==null)') ||
      reconcileLease.includes("if(!['reviewed_prompt_grant','admitted_cleanup'].includes(lease.ownershipProof))")) &&
    reconcileLease.indexOf('permissionsPreserved:true') < reconcileLease.indexOf('awaitreleaseHostPermissions(')
  );
  const externalRemovalInvalidationIndex = onRemovedRoute.indexOf(
    'invalidateRemovedCleanupPermissionOwnership({origins:externalRemovedOrigins})'
  );
  const externalRemovalSerializationIndex = onRemovedRoute.lastIndexOf(
    'serializeCleanupReviewStateMutation',
    externalRemovalInvalidationIndex
  );
  const serializedSelfRemovalReconciliation =
    'serializeCleanupReviewStateMutation(()=>reconcileObservedSelfPermissionRemoval(selfRemovedOrigins))';
  const selfRemovalReconciliationIndex = onRemovedRoute.indexOf(serializedSelfRemovalReconciliation);
  const externalOnlyEarlyReturnIndex = onRemovedRoute.indexOf('if(!externalRemovedOrigins.length)return');
  const removalInvalidatesAuthority = Boolean(
    /const\s+cleanupPermissionRemovalPoisonOrigins\s*=\s*new\s+Set\(\)\s*;/.test(workerSource) &&
    /const\s+cleanupPermissionSelfRemovalReservations\s*=\s*new\s+Set\(\)\s*;/.test(workerSource) &&
    /let\s+cleanupPermissionExternalInvalidationRevision\s*=\s*0\s*;/.test(workerSource) &&
    /const\s+cleanupPermissionExternalInvalidationReservations\s*=\s*new\s+Set\(\)\s*;/.test(workerSource) &&
    /const\s+MISSING_OWNED_ACCESS_TOMBSTONE_REASON\s*=\s*['"]owned_exact_access_missing_on_recovery['"]\s*;/.test(
      workerSource
    ) &&
    onRemovedRoute.includes(
      'const{externalRemovedOrigins,selfRemovedOrigins}=observePermissionRemovalEvent(removedPermissions)'
    ) &&
    onRemovedRoute.includes('if(selfRemovedOrigins.length)') &&
    onRemovedRoute.includes(serializedSelfRemovalReconciliation) &&
    onRemovedRoute.includes('if(!externalRemovedOrigins.length)return') &&
    selfRemovalReconciliationIndex >= 0 &&
    externalOnlyEarlyReturnIndex >= 0 &&
    selfRemovalReconciliationIndex < externalOnlyEarlyReturnIndex &&
    onRemovedRoute.includes('reserveExternalCleanupPermissionInvalidation(externalRemovedOrigins)') &&
    onRemovedRoute.indexOf('reserveExternalCleanupPermissionInvalidation(externalRemovedOrigins)') <
      externalRemovalSerializationIndex &&
    onRemovedRoute.includes('rememberRemovedCleanupPermissionOrigins({origins:externalRemovedOrigins})') &&
    onRemovedRoute.indexOf('rememberRemovedCleanupPermissionOrigins({origins:externalRemovedOrigins})') <
      externalRemovalSerializationIndex &&
    externalRemovalSerializationIndex >= 0 &&
    externalRemovalSerializationIndex < externalRemovalInvalidationIndex &&
    onRemovedRoute.includes('invalidateRemovedCleanupPermissionOwnership({origins:externalRemovedOrigins})') &&
    onAddedRoute.includes('reservation.regrantedOrigins.add(origin)') &&
    onAddedRoute.includes('cleanupPermissionRemovalPoisonOrigins.has(origin)') &&
    onAddedRoute.includes('invalidateRemovedCleanupPermissionOwnership') &&
    removalEventState.includes('cleanupPermissionRemovalPoisonOrigins.add(origin)') &&
    removalEventState.includes('reservation.observedOrigins.add(origin)') &&
    removalEventState.includes('candidate.regrantedOrigins.has(origin)') &&
    removalEventState.includes('clearCleanupPermissionRemovalPoison(absentObservedOrigins)') &&
    removalEventState.includes('revision:++cleanupPermissionExternalInvalidationRevision') &&
    removalEventState.includes('cleanupPermissionExternalInvalidationReservations.add(reservation)') &&
    removalEventState.includes('externalCleanupPermissionInvalidationIntersects(origins=[])') &&
    reviewRemovalInvalidation.includes('getTemporaryReviewHostPermissionOrigins(review)') &&
    reviewRemovalInvalidation.includes('temporaryOrigins.some((origin)=>removedOrigins.includes(origin))') &&
    reviewRemovalInvalidation.includes('chrome.storage.session.remove(CLEANUP_REVIEW_STORAGE_KEY)') &&
    leaseRemovalInvalidation.includes('revokePermissionLeaseOwnership(chrome.storage.local,removedOrigins)') &&
    leaseRemovalInvalidation.includes(
      'discardPermissionLeaseAfterObservedRemoval(chrome.storage.local,removedOrigins)'
    ) &&
    combinedRemovalInvalidation.includes('rememberRemovedCleanupPermissionOrigins(removedPermissions)') &&
    combinedRemovalInvalidation.includes(
      'awaitPromise.all([invalidateRemovedCleanupReviewAuthority(removedOrigins),invalidateRemovedPermissionLeaseAuthority(removedOrigins)])'
    ) &&
    combinedRemovalInvalidation.includes("poisonServiceWorkerLoadReadiness('removed-target-access-invalidation')") &&
    combinedRemovalInvalidation.includes('clearCleanupPermissionRemovalPoison(removedOrigins)') &&
    combinedRemovalInvalidation.includes('settleExternalCleanupPermissionInvalidations(removedOrigins)') &&
    liveReviewPermissionBinding.includes('cleanupPermissionRemovalPoisonIntersects(lease.temporaryOrigins||[])') &&
    strictPermissionInspection.split('cleanupPermissionRemovalPoisonIntersects(inspectedOrigins)').length - 1 >= 2 &&
    strictPermissionInspection.includes(
      'cleanupPermissionRemovalPoisonOrigins.size&&!selfRemovalInventoryMaySettle()'
    ) &&
    strictPermissionInspection.includes('settleSelfRemovalReservationsFromInventory(snapshot)') &&
    restartLeaseRecovery.includes('constinventory=awaitgetAllHostPermissionsStrict()') &&
    restartLeaseRecovery.includes('constexternalInvalidationRevision=cleanupPermissionExternalInvalidationRevision') &&
    restartLeaseRecovery.includes(
      'constleaseMatchesPreservedCleanupReview=permissionLeaseMatchesLiveCleanupReview(lease,preservedCleanupReview)'
    ) &&
    restartLeaseRecovery.includes(
      "if(!expectedLeaseId&&!leaseMatchesPreservedCleanupReview&&lease.ownershipProof==='reviewed_prompt_grant')"
    ) &&
    restartLeaseRecovery.includes('constambiguousGrant=awaitdiscardInvalidReviewPermissionLease(storageLocal)') &&
    restartLeaseRecovery.includes('expectedExternalInvalidationRevision:externalInvalidationRevision') &&
    restartLeaseRecovery.includes('expectedLeaseId:lease.id') &&
    restartLeaseRecovery.includes(
      'constmissingTemporaryOrigins=lease.temporaryOrigins.filter((origin)=>!exactGrantedOrigins.has(origin))'
    ) &&
    restartLeaseRecovery.includes('if(missingTemporaryOrigins.length)') &&
    restartLeaseRecovery.includes('tombstoneReason:MISSING_OWNED_ACCESS_TOMBSTONE_REASON') &&
    restartLeaseRecovery.includes("status:'prompt_tombstone'") &&
    restartLeaseRecovery.includes('approval:null') &&
    restartLeaseRecovery.includes(
      'constreviewPoison=awaitPromise.allSettled([storageSession.set({[CLEANUP_REVIEW_STORAGE_KEY]:missingAccessTombstone})])'
    ) &&
    restartLeaseRecovery.includes(
      'constrevoked=awaitrevokePermissionLeaseOwnership(storageLocal,missingTemporaryOrigins)'
    ) &&
    restartLeaseRecovery.includes(
      'awaitdiscardPermissionLeaseAfterObservedRemoval(storageLocal,missingTemporaryOrigins)'
    ) &&
    restartLeaseRecovery.includes('if(!leaseNeutralized)') &&
    restartLeaseRecovery.includes('awaitstorageSession.remove(CLEANUP_REVIEW_STORAGE_KEY).catch(()=>{})') &&
    restartLeaseRecovery.includes('clearCleanupPermissionRemovalPoison(missingTemporaryOrigins)') &&
    restartLeaseRecovery.includes('livePreparedAuthority:false') &&
    restartLeaseRecovery.includes(
      'preservedCleanupReview?.approvalHandoff?.tombstoneReason===MISSING_OWNED_ACCESS_TOMBSTONE_REASON'
    ) &&
    compactWorker.includes('review.approvalHandoff.tombstoneReason===MISSING_OWNED_ACCESS_TOMBSTONE_REASON') &&
    compactWorker.includes(
      "recoverTemporaryPermissionLease('missing-owned-access-tombstone',null,{storageSession,storageLocal,preservedCleanupReview:review,forcePromptSettlement:false})"
    ) &&
    temporaryPermissionRelease.includes('cleanupPermissionRemovalPoisonIntersects(exactTargetOrigins)') &&
    temporaryPermissionRelease.includes('externalCleanupPermissionInvalidationIntersects(exactTargetOrigins)') &&
    temporaryPermissionRelease.includes(
      'constdurableLease=awaitgetPermissionLease(options.storageLocal||chrome.storage.local)'
    ) &&
    temporaryPermissionRelease.split(
      'cleanupPermissionExternalInvalidationRevision!==expectedExternalInvalidationRevision'
    ).length -
      1 >=
      2 &&
    temporaryPermissionRelease.lastIndexOf(
      'cleanupPermissionExternalInvalidationRevision!==expectedExternalInvalidationRevision'
    ) > temporaryPermissionRelease.indexOf('constdurableLease=awaitgetPermissionLease(') &&
    temporaryPermissionRelease.indexOf('awaitchrome.permissions.remove({origins:exactTargetOrigins})') >
      temporaryPermissionRelease.lastIndexOf(
        'cleanupPermissionExternalInvalidationRevision!==expectedExternalInvalidationRevision'
      ) &&
    temporaryPermissionRelease.includes('cleanupPermissionSelfRemovalReservations.add(reservation)')
  );
  if (!revokedOrProoflessAccessIsPreserved || !removalInvalidatesAuthority) {
    findings.push(
      'permission ownership: intersecting onRemoved must serially revoke proof and invalidate pending authority; revoked, proofless, and legacy leases must preserve access and cannot authorize later manual regrant cleanup/removal'
    );
  }
}

function validateReplacementPopupRecoveryLock(source, findings) {
  const sourceFile = parseJavaScriptSource('src/popup/popup.js', source, findings);
  if (!sourceFile) return;

  const recoveryHelper = findNamedFunction(sourceFile, 'temporaryHostAccessNeedsRecovery');
  const recoveryStatements = recoveryHelper?.body?.body || [];
  const emptyAccessGuard = recoveryStatements[0];
  const durableObligationLocks = Boolean(
    recoveryStatements.length === 2 &&
    emptyAccessGuard?.type === 'IfStatement' &&
    compactNodeText(emptyAccessGuard.test, sourceFile).replaceAll('"', "'") === "!access||access.state==='none'" &&
    compactNodeText(emptyAccessGuard.consequent, sourceFile) === 'returnfalse;' &&
    recoveryStatements[1]?.type === 'ReturnStatement' &&
    recoveryStatements[1].argument?.type === 'Literal' &&
    recoveryStatements[1].argument.value === true
  );

  const hydrate = findNamedFunction(sourceFile, 'hydrateState');
  const hydrateAssignment = hydrate
    ? findNode(
        hydrate.body,
        (node) =>
          node.type === 'AssignmentExpression' &&
          isExactCallAssignment(
            node,
            'permissionRecoveryPending',
            'temporaryHostAccessNeedsRecovery',
            'state.temporaryHostAccess'
          )
      )
    : null;
  const hydrateRecoveryGuard = hydrate
    ? findNode(
        hydrate.body,
        (node) =>
          node.type === 'IfStatement' &&
          compactNodeText(node.test, sourceFile) === '!cleanupRunning&&permissionRecoveryPending' &&
          containsCallNamed(node.consequent, 'renderPermissionRecoveryPending')
      )
    : null;

  const refresh = findNamedFunction(sourceFile, 'refreshPermissionRecoveryState');
  const localFlow = refresh ? findVariableDeclaration(refresh.body, 'localApprovalFlowActive') : null;
  const localLease = refresh ? findVariableDeclaration(refresh.body, 'localPreparedPromptLease') : null;
  const refreshedPending = refresh
    ? findNode(
        refresh.body,
        (node) =>
          node.type === 'AssignmentExpression' &&
          compactNodeText(node, sourceFile) ===
            'permissionRecoveryPending=temporaryHostAccessNeedsRecovery(access)&&!localPreparedPromptLease'
      )
    : null;
  const sameDocumentExceptionIsNarrow = Boolean(
    compactNodeText(localFlow?.init, sourceFile) ===
      'Boolean(cleanupReview||directCleanupReview||directPreparationPending||popupAuthorityContinuations.size>0)' &&
    compactNodeText(localLease?.init, sourceFile).replaceAll('"', "'") ===
      "!forceRecoveryUi&&access.state==='prompt_pending'&&(busy||localApprovalFlowActive)" &&
    refreshedPending
  );

  const updatePrimary = findNamedFunction(sourceFile, 'updatePrimaryAction');
  const primaryRecoveryGuard = updatePrimary?.body?.body.find(
    (statement) =>
      statement.type === 'IfStatement' &&
      compactNodeText(statement.test, sourceFile) === 'cleanupReview||permissionRecoveryPending'
  );
  const primaryGuardText = compactNodeText(primaryRecoveryGuard?.consequent, sourceFile);
  const primaryActionLocks = Boolean(
    primaryRecoveryGuard &&
    primaryGuardText.includes("qs('#deepCleanButton').disabled=true") &&
    containsNodeType(primaryRecoveryGuard.consequent, 'ReturnStatement')
  );

  if (
    !durableObligationLocks ||
    !hydrateAssignment ||
    !hydrateRecoveryGuard ||
    !sameDocumentExceptionIsNarrow ||
    !primaryActionLocks
  ) {
    findings.push(
      'src/popup/popup.js: a replacement popup must recovery-lock every durable temporary-access obligation while only the initiating live document may continue its own prompt'
    );
  }
}

function validateDurableArmAcknowledgement(preflightSource, findings) {
  const sourceFile = parseJavaScriptSource('src/background/cleanup-preflight.js', preflightSource, findings);
  if (!sourceFile) return;
  const armFunction = findNamedFunction(sourceFile, 'armCleanupReviewApprovalRequest');
  const armStatements = armFunction?.body?.body || [];
  const armedRecord = armFunction ? findVariableDeclaration(armFunction.body, 'approvalHandoff') : null;
  const armedRecordText = compactNodeText(armedRecord?.init, sourceFile).replaceAll('"', "'");
  const durableWrite = armFunction
    ? findNode(
        armFunction.body,
        (node) =>
          node.type === 'AwaitExpression' &&
          unwrapExpression(node.argument)?.type === 'CallExpression' &&
          memberPath(unwrapExpression(node.argument).callee) === 'storageSession.set' &&
          compactNodeText(unwrapExpression(node.argument).arguments?.[0], sourceFile).includes('approvalHandoff')
      )
    : null;
  const acknowledgment = armStatements.at(-1);
  const acknowledgmentText = compactNodeText(acknowledgment?.argument, sourceFile).replaceAll('"', "'");
  const durableAcknowledgementIsExact = Boolean(
    armFunction &&
    armedRecordText.includes("status:'armed'") &&
    durableWrite &&
    acknowledgment?.type === 'ReturnStatement' &&
    acknowledgment.start > durableWrite.end &&
    acknowledgmentText ===
      "{approvalStaged:true,approvalArmed:true,handoffStatus:'armed',handoffNonce:armingHandoff.nonce,expiresAt:newDate(record.expiresAtMs).toISOString()}"
  );
  if (!durableAcknowledgementIsExact) {
    findings.push(
      'src/background/cleanup-preflight.js: the exact armed acknowledgement must be returned only after durable armed-state persistence'
    );
  }
}

function validateExternalRunDeepCleanWorkerBinding(source, findings) {
  const route = sourceRange(source, 'case MESSAGE_TYPES.runDeepClean:', 'case MESSAGE_TYPES.getReport:');
  const reservationAt = route.indexOf("withCleanupLifecycleReservation('cleanup'");
  const exactSenderAt = route.indexOf("assertExactPopupSender(sender, 'run a prepared cleanup')");
  const reviewReadAt = route.indexOf('readCleanupReviewRecord(chrome.storage.session)');
  const bindingCheckAt = route.indexOf('assertCleanupReviewPopupBinding(review, payload)');
  const bindingIsCheckedBeforeReservation =
    exactSenderAt >= 0 &&
    reviewReadAt > exactSenderAt &&
    bindingCheckAt > reviewReadAt &&
    reservationAt > bindingCheckAt;
  const bindingIsRecheckedAtConsume = /requirePopupPreparationCapability:\s*!trustedInternalArmedCleanup/.test(route);
  if (!route || !bindingIsCheckedBeforeReservation || !bindingIsRecheckedAtConsume) {
    findings.push(
      'src/background/service-worker.js: external runDeepClean must verify the current exact popup binding before reservation and again at atomic approval consumption'
    );
  }

  const internalHelper = sourceRange(
    source,
    'function isTrustedInternalArmedCleanup(',
    'function assertExactPopupSender('
  );
  if (
    !internalHelper ||
    !/internalContext\?\.expectedApprovalHandoffNonce/.test(internalHelper) ||
    !/message\?\.type\s*===\s*MESSAGE_TYPES\.runDeepClean/.test(internalHelper) ||
    !/sender\?\.id\s*===\s*chrome\.runtime\.id/.test(internalHelper) ||
    !/sender\?\.tab\s*==\s*null/.test(internalHelper) ||
    !/chrome\.runtime\.getURL\(['"]background\/service-worker\.js['"]\)/.test(internalHelper) ||
    /message\??\.payload/.test(internalHelper)
  ) {
    findings.push(
      'src/background/service-worker.js: the armed-cleanup validation exception must remain worker-only and non-payload-selectable'
    );
  }
  validateServiceWorkerPopupBindingAst(source, findings);
}

function validateTransientPopupCapabilityPersistence(preflightSource, stateSchemaSource, findings) {
  const reviewRecord = sourceRange(
    preflightSource,
    'const record = {',
    'await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: record })'
  );
  const cleanupJobNormalizer = sourceRange(
    stateSchemaSource,
    'export function normalizeCleanupJob(',
    'export function assertCleanupJobTransition('
  );
  const reviewPersistsDigestOnly =
    /\bpopupPreparationCapabilityDigest\s*,/.test(reviewRecord) &&
    !/\bpopupPreparationCapability\s*(?:,|:)/.test(reviewRecord);
  const jobPersistsDigestOnly =
    /output\.popupPreparationCapabilityDigest\s*=/.test(cleanupJobNormalizer) &&
    !/output\.popupPreparationCapability\s*=/.test(cleanupJobNormalizer);
  if (!reviewPersistsDigestOnly || !jobPersistsDigestOnly) {
    findings.push(
      'runtime state: raw popup preparation capability must never be persisted; only its digest and opaque context may be stored'
    );
  }
}

function validateRunDeepCleanMessageAst(source, findings) {
  const sourceFile = parseJavaScriptSource('src/shared/message-contracts.js', source, findings);
  if (!sourceFile) return;
  const runCase = findCaseClause(sourceFile, 'MESSAGE_TYPES.runDeepClean');
  const runStatements = runCase?.consequent || [];
  const assertKeysAt = runStatements.findIndex(
    (statement) => callName(directCallFromStatement(statement)) === 'assertKeys'
  );
  const assertKeysCall = assertKeysAt >= 0 ? directCallFromStatement(runStatements[assertKeysAt]) : null;
  const allowlist = assertKeysCall?.arguments?.[1] || null;
  const allowlistIsExact = Boolean(
    allowlist &&
    allowlist.type === 'ConditionalExpression' &&
    isBooleanFlagComparison(allowlist.test, 'validationOptions.allowInternalArmedCleanup', '===', true) &&
    sameStrings(stringArrayValues(allowlist.consequent), INTERNAL_ARMED_CLEANUP_FIELDS) &&
    sameStrings(stringArrayValues(allowlist.alternate), EXTERNAL_RUN_DEEP_CLEAN_FIELDS)
  );
  const activeBindingGuard = runStatements.some(
    (statement) =>
      statement.type === 'IfStatement' &&
      isBooleanFlagComparison(statement.test, 'validationOptions.allowInternalArmedCleanup', '!==', true) &&
      callName(directCallFromStatement(statement.consequent)) === 'assertPopupPreparationBinding'
  );
  const runValidationSequenceIsClosed = Boolean(
    runStatements.length === 7 &&
    runStatements[6]?.type === 'ReturnStatement' &&
    !runStatements.slice(0, -1).some((statement) => containsNodeType(statement, 'ReturnStatement'))
  );
  const envelopeFunction = findNamedFunction(sourceFile, 'validateMessageEnvelope');
  const envelopeStatements = envelopeFunction?.body?.body || [];
  const payloadValidationAt = envelopeStatements.findIndex(
    (statement) => callName(directCallFromStatement(statement)) === 'validatePayload'
  );
  const payloadValidationCall =
    payloadValidationAt >= 0 ? directCallFromStatement(envelopeStatements[payloadValidationAt]) : null;
  const envelopeReturnAt = envelopeStatements.findIndex((statement) => statement.type === 'ReturnStatement');
  const payloadValidationIsActive = Boolean(
    payloadValidationCall &&
    payloadValidationAt >= 0 &&
    envelopeReturnAt > payloadValidationAt &&
    sameStrings(payloadValidationCall.arguments.map(memberPath), ['type', 'payload', 'validationOptions'])
  );
  const validatePayloadFunction = findNamedFunction(sourceFile, 'validatePayload');
  const validatePayloadStatements = validatePayloadFunction?.body?.body || [];
  const validatePayloadControlFlowIsClosed = Boolean(
    validatePayloadStatements.length === 2 &&
    validatePayloadStatements[0]?.type === 'IfStatement' &&
    validatePayloadStatements[1]?.type === 'SwitchStatement' &&
    memberPath(validatePayloadStatements[1].discriminant) === 'type'
  );
  if (
    !runCase ||
    assertKeysAt !== 0 ||
    !assertKeysCall ||
    !allowlistIsExact ||
    !activeBindingGuard ||
    !runValidationSequenceIsClosed ||
    !payloadValidationIsActive ||
    !validatePayloadControlFlowIsClosed
  ) {
    findings.push(
      'src/shared/message-contracts.js: runDeepClean must actively enforce its exact external/internal allowlists and required popup binding'
    );
  }

  const assertKeys = findNamedFunction(sourceFile, 'assertKeys');
  const failHelper = findNamedFunction(sourceFile, 'fail');
  if (
    !assertKeys ||
    !assertKeysRejectsUnknownOwnKeys(assertKeys) ||
    !failHelper ||
    !messageValidationFailureIsUnconditional(failHelper, sourceFile)
  ) {
    findings.push(
      'src/shared/message-contracts.js: assertKeys must reject every unknown own payload key instead of merely retaining a call-site marker'
    );
  }
}

function messageValidationFailureIsUnconditional(functionNode, sourceFile) {
  const statements = functionNode.body?.body || [];
  const errorDeclaration = statements[0]?.declarations?.[0];
  const nameAssignment = statements[1]?.expression;
  return Boolean(
    statements.length === 3 &&
    statements[0]?.type === 'VariableDeclaration' &&
    propertyName(errorDeclaration?.id) === 'error' &&
    errorDeclaration?.init?.type === 'NewExpression' &&
    memberPath(errorDeclaration.init.callee) === 'Error' &&
    sameStrings(errorDeclaration.init.arguments.map(memberPath), ['message']) &&
    statements[1]?.type === 'ExpressionStatement' &&
    nameAssignment?.type === 'AssignmentExpression' &&
    nameAssignment.operator === '=' &&
    memberPath(nameAssignment.left) === 'error.name' &&
    stringLiteralValue(nameAssignment.right) === 'MessageValidationError' &&
    statements[2]?.type === 'ThrowStatement' &&
    memberPath(statements[2].argument) === 'error' &&
    compactNodeText(functionNode.params?.[0], sourceFile) === 'message'
  );
}

function assertKeysRejectsUnknownOwnKeys(functionNode) {
  const statements = functionNode.body?.body || [];
  const allowedDeclaration = findVariableDeclaration(functionNode, 'allowed');
  const unknownDeclaration = findVariableDeclaration(functionNode, 'unknown');
  const allowedInitializer = unwrapExpression(allowedDeclaration?.init);
  const unknownInitializer = unwrapExpression(unknownDeclaration?.init);
  const allowedSetIsBound = Boolean(
    allowedInitializer &&
    allowedInitializer.type === 'NewExpression' &&
    memberPath(allowedInitializer.callee) === 'Set' &&
    memberPath(allowedInitializer.arguments?.[0]) === 'allowedKeys'
  );
  const rejectsEachUnknownKey = isUnknownKeyFilter(unknownInitializer);
  const activeFailure = functionNode.body?.body.some(
    (statement) =>
      statement.type === 'IfStatement' &&
      isNonemptyArrayTest(statement.test, 'unknown') &&
      (containsCallNamed(statement.consequent, 'fail') || containsNodeType(statement.consequent, 'ThrowStatement'))
  );
  return Boolean(
    statements.length === 3 &&
    statements[0]?.type === 'VariableDeclaration' &&
    statements[1]?.type === 'VariableDeclaration' &&
    statements[2]?.type === 'IfStatement' &&
    !containsNodeType(functionNode.body, 'ReturnStatement') &&
    allowedSetIsBound &&
    rejectsEachUnknownKey &&
    activeFailure
  );
}

function validateServiceWorkerPopupBindingAst(source, findings) {
  const sourceFile = parseJavaScriptSource('src/background/service-worker.js', source, findings);
  if (!sourceFile) return;
  const handleMessage = findNamedFunction(sourceFile, 'handleMessage');
  const trustedBinding = handleMessage
    ? findVariableDeclaration(handleMessage.body, 'trustedInternalArmedCleanup', {
        directStatementsOnly: true
      })
    : null;
  const trustedCall = unwrapExpression(trustedBinding?.init);
  const trustedBindingIsExact = Boolean(
    trustedCall?.type === 'CallExpression' &&
    memberPath(trustedCall.callee) === 'isTrustedInternalArmedCleanup' &&
    sameStrings(trustedCall.arguments.map(memberPath), ['message', 'sender', 'internalContext'])
  );
  const envelopeBinding = handleMessage
    ? findVariableDeclaration(handleMessage.body, 'envelope', { directStatementsOnly: true })
    : null;
  const envelopeCall = unwrapExpression(envelopeBinding?.init);
  const validationOptions = envelopeCall?.arguments?.[3];
  const allowInternalProperties =
    validationOptions?.type === 'ObjectExpression'
      ? validationOptions.properties.filter(
          (property) => property.type === 'Property' && propertyName(property.key) === 'allowInternalArmedCleanup'
        )
      : [];
  const envelopeBindingIsExact = Boolean(
    envelopeCall?.type === 'CallExpression' &&
    memberPath(envelopeCall.callee) === 'validateMessageEnvelope' &&
    sameStrings(envelopeCall.arguments.slice(0, 3).map(memberPath), ['message', 'sender', 'chrome.runtime.id']) &&
    allowInternalProperties.length === 1 &&
    memberPath(allowInternalProperties[0].value) === 'trustedInternalArmedCleanup'
  );
  const runCase = findCaseClause(sourceFile, 'MESSAGE_TYPES.runDeepClean');
  const routeStatements = caseStatements(runCase);
  const externalGuard = routeStatements.find(
    (statement) =>
      statement.type === 'IfStatement' && isNegatedIdentifier(statement.test, 'trustedInternalArmedCleanup')
  );
  const reservationReturn = routeStatements.find((statement) => statement.type === 'ReturnStatement');
  const guardBlock = externalGuard?.consequent?.type === 'BlockStatement' ? externalGuard.consequent : null;
  const guardStatements = guardBlock?.body || [];
  const exactSenderAt = guardStatements.findIndex(
    (statement) => callName(directCallFromStatement(statement)) === 'assertExactPopupSender'
  );
  const reviewRead = guardBlock ? findVariableDeclaration(guardBlock, 'review', { directStatementsOnly: true }) : null;
  const reviewReadCall = reviewRead?.init
    ? findCallExpression(reviewRead.init, (call) => memberPath(call.callee) === 'readCleanupReviewRecord')
    : null;
  const reviewReadAt = reviewRead ? guardStatements.findIndex((statement) => nodeContains(statement, reviewRead)) : -1;
  const bindingAt = guardStatements.findIndex(
    (statement) => callName(directCallFromStatement(statement)) === 'assertCleanupReviewPopupBinding'
  );
  const guardDominatesReservation = Boolean(
    runCase &&
    routeStatements.length === 2 &&
    routeStatements[0] === externalGuard &&
    routeStatements[1] === reservationReturn &&
    externalGuard &&
    guardBlock &&
    exactSenderAt >= 0 &&
    reviewReadCall &&
    reviewReadAt > exactSenderAt &&
    bindingAt > reviewReadAt &&
    reservationReturn &&
    externalGuard.start < reservationReturn.start &&
    findCallExpression(reservationReturn, (call) => memberPath(call.callee) === 'withCleanupLifecycleReservation')
  );

  const consumeCall = reservationReturn
    ? findCallExpression(reservationReturn, (call) => memberPath(call.callee) === 'consumeCleanupReviewRequest')
    : null;
  const consumeOptions = consumeCall?.arguments?.[1];
  const capabilityProperties =
    consumeOptions?.type === 'ObjectExpression'
      ? consumeOptions.properties.filter(
          (property) =>
            property.type === 'Property' &&
            property.kind === 'init' &&
            propertyName(property.key) === 'requirePopupPreparationCapability'
        )
      : [];
  const activeConsumeRecheck = Boolean(
    capabilityProperties.length === 1 &&
    isNegatedIdentifier(capabilityProperties[0].value, 'trustedInternalArmedCleanup')
  );
  if (!guardDominatesReservation || !activeConsumeRecheck) {
    findings.push(
      'src/background/service-worker.js: external popup checks must be live, dominate cleanup reservation, and actively recheck capability at consumption'
    );
  }

  const exactSenderHelper = findNamedFunction(sourceFile, 'assertExactPopupSender');
  if (!exactSenderHelper || !exactPopupSenderHelperIsRestrictive(exactSenderHelper, sourceFile)) {
    findings.push(
      'src/background/service-worker.js: assertExactPopupSender must actively reject wrong extension IDs, URLs, origins, and tab-shaped senders'
    );
  }

  const internalHelper = findNamedFunction(sourceFile, 'isTrustedInternalArmedCleanup');
  if (
    !trustedBindingIsExact ||
    !envelopeBindingIsExact ||
    !internalHelper ||
    !internalArmedCleanupHelperIsClosed(internalHelper, sourceFile)
  ) {
    findings.push(
      'src/background/service-worker.js: internal armed cleanup selection must be an exact worker-only conjunction with no caller-payload dataflow'
    );
  }
}

function validateServiceWorkerPopupContextSemantics(source, findings) {
  const sourceFile = parseJavaScriptSource('src/background/service-worker.js', source, findings);
  if (!sourceFile) return;

  const validator = findNamedFunction(sourceFile, 'validateRuntimePopupContext');
  const validatorStatements = validator?.body?.body || [];
  const popupUrl = validator
    ? findVariableDeclaration(validator.body, 'popupUrl', { directStatementsOnly: true })
    : null;
  const contextId = validator
    ? findVariableDeclaration(validator.body, 'contextId', { directStatementsOnly: true })
    : null;
  const sharedExtensionProfile = validator
    ? findVariableDeclaration(validator.body, 'sharedExtensionProfile', { directStatementsOnly: true })
    : null;
  const rejectingGuard = validatorStatements.find(
    (statement) => statement.type === 'IfStatement' && containsNodeType(statement.consequent, 'ThrowStatement')
  );
  const validatorReturn = validatorStatements.at(-1);
  const validatorTerms = rejectingGuard
    ? flattenLogicalOr(rejectingGuard.test).map((term) => compactNodeText(term, sourceFile).replaceAll('"', "'"))
    : [];
  const validatorIsExact = Boolean(
    validator &&
    validatorStatements.length === 5 &&
    validatorStatements[3] === rejectingGuard &&
    popupUrl?.init?.type === 'CallExpression' &&
    memberPath(popupUrl.init.callee) === 'chrome.runtime.getURL' &&
    stringLiteralValue(popupUrl.init.arguments[0]) === 'popup/popup.html' &&
    compactNodeText(contextId?.init, sourceFile) === 'normalizeRuntimePopupContextId(context?.contextId)' &&
    compactNodeText(sharedExtensionProfile?.init, sourceFile).replaceAll('"', "'") ===
      "chrome.runtime.getManifest()?.incognito!=='split'" &&
    sameStrings(validatorTerms, [
      '!contextId',
      'expectedContextId&&contextId!==expectedContextId',
      "context?.contextType!=='POPUP'",
      'context?.documentUrl!==popupUrl',
      'context?.tabId!==-1',
      'context?.windowId!==-1',
      "typeofcontext?.incognito!=='boolean'",
      'sharedExtensionProfile&&context.incognito'
    ]) &&
    validatorReturn?.type === 'ReturnStatement' &&
    compactNodeText(validatorReturn.argument, sourceFile) ===
      '{contextId,windowId:context.windowId,incognito:context.incognito}' &&
    !compactNodeText(validator, sourceFile).includes('sender.documentId')
  );
  if (!validatorIsExact) {
    findings.push(
      'src/background/service-worker.js: runtime.getContexts popup validation must require Chrome action-popup sentinel ids, exact type/URL, opaque contextId, and spanning-profile state'
    );
  }

  const inspector = findNamedFunction(sourceFile, 'inspectExactPreparingPopupContext');
  const inspectorStatements = inspector?.body?.body || [];
  const inspectorPopupUrl = inspector
    ? findVariableDeclaration(inspector.body, 'popupUrl', { directStatementsOnly: true })
    : null;
  const contexts = inspector
    ? findVariableDeclaration(inspector.body, 'contexts', { directStatementsOnly: true })
    : null;
  const getContextsCall = contexts
    ? findCallExpression(contexts.init, (call) => memberPath(call.callee) === 'chrome.runtime.getContexts')
    : null;
  const filter = unwrapExpression(getContextsCall?.arguments?.[0]);
  const filterProperties =
    filter?.type === 'ObjectExpression'
      ? filter.properties.filter((property) => property.type === 'Property' && property.kind === 'init')
      : [];
  const contextTypes = filterProperties.find((property) => propertyName(property.key) === 'contextTypes');
  const documentUrls = filterProperties.find((property) => propertyName(property.key) === 'documentUrls');
  const documentUrlValues = unwrapExpression(documentUrls?.value)?.elements?.map(memberPath) || [];
  const inspectorReturn = inspectorStatements.at(-1);
  const returnedValidation = unwrapExpression(inspectorReturn?.argument);
  const inspectorText = compactNodeText(inspector, sourceFile).replaceAll('"', "'");
  const inspectorIsExact = Boolean(
    inspector &&
    inspector.params.length === 0 &&
    inspectorStatements.length === 6 &&
    compactNodeText(inspectorStatements[0]?.test, sourceFile).replaceAll('"', "'") ===
      "typeofchrome.runtime.getContexts!=='function'" &&
    inspectorPopupUrl?.init?.type === 'CallExpression' &&
    memberPath(inspectorPopupUrl.init.callee) === 'chrome.runtime.getURL' &&
    stringLiteralValue(inspectorPopupUrl.init.arguments[0]) === 'popup/popup.html' &&
    getContextsCall &&
    filterProperties.length === 2 &&
    sameStrings(stringArrayValues(contextTypes?.value) || [], ['POPUP']) &&
    sameStrings(documentUrlValues, ['popupUrl']) &&
    inspectorText.includes('!Array.isArray(contexts)') &&
    inspectorText.includes('contexts.length!==1') &&
    inspectorReturn?.type === 'ReturnStatement' &&
    returnedValidation?.type === 'CallExpression' &&
    memberPath(returnedValidation.callee) === 'validateRuntimePopupContext' &&
    returnedValidation.arguments.length === 1 &&
    compactNodeText(returnedValidation.arguments[0], sourceFile) === 'contexts[0]'
  );
  if (!inspectorIsExact) {
    findings.push(
      'src/background/service-worker.js: popup inspection must query exactly one exact-URL POPUP context and validate the returned Chrome context'
    );
  }

  const prepareCase = findCaseClause(sourceFile, 'MESSAGE_TYPES.prepareCleanupReview');
  const popupContext = prepareCase ? findVariableDeclaration(prepareCase, 'popupContext') : null;
  const popupContextCall = unwrapExpression(popupContext?.init);
  const prepareText = compactNodeText(prepareCase, sourceFile);
  const preparationUsesWorkerContext = Boolean(
    prepareCase &&
    popupContextCall?.type === 'CallExpression' &&
    memberPath(popupContextCall.callee) === 'inspectExactPreparingPopupContext' &&
    popupContextCall.arguments.length === 0 &&
    prepareText.includes('preparationContextId:popupContext.contextId') &&
    !prepareText.includes('sender.documentId') &&
    !prepareText.includes('sender?.documentId')
  );
  if (!preparationUsesWorkerContext) {
    findings.push(
      'src/background/service-worker.js: cleanup preparation must bind only the worker-resolved popup contextId, never optional sender.documentId'
    );
  }

  const liveness = findNamedFunction(sourceFile, 'inspectPreparationContextActive');
  const livenessText = compactNodeText(liveness, sourceFile);
  const livenessIsBound = Boolean(
    liveness &&
    livenessText.includes('chrome.runtime.getContexts({contextIds:[normalizedContextId]})') &&
    livenessText.includes('validateRuntimePopupContext(contexts[0],{expectedContextId:normalizedContextId})')
  );
  if (!livenessIsBound) {
    findings.push(
      'src/background/service-worker.js: popup-context liveness must query the exact contextId and revalidate its complete Chrome context'
    );
  }
}

function exactPopupSenderHelperIsRestrictive(functionNode, sourceFile) {
  const statements = functionNode.body?.body || [];
  const popupUrl = findVariableDeclaration(functionNode, 'popupUrl', { directStatementsOnly: true });
  const extensionOrigin = findVariableDeclaration(functionNode, 'extensionOrigin', {
    directStatementsOnly: true
  });
  const reportedUrls = findVariableDeclaration(functionNode, 'reportedUrls', {
    directStatementsOnly: true
  });
  const popupUrlIsExact = Boolean(
    popupUrl?.init?.type === 'CallExpression' &&
    memberPath(popupUrl.init.callee) === 'chrome.runtime.getURL' &&
    stringLiteralValue(popupUrl.init.arguments[0]) === 'popup/popup.html'
  );
  const extensionOriginIsExact =
    compactNodeText(extensionOrigin?.init, sourceFile).replaceAll('"', "'") ===
    "chrome.runtime.getURL('').replace(/\\/$/,'')";
  const reportedUrlsIsExact =
    compactNodeText(reportedUrls?.init, sourceFile).replaceAll('"', "'") ===
    "[sender?.documentUrl,sender?.url].filter((value)=>typeofvalue==='string'&&value.length>0)";
  const rejectingGuard = statements.find(
    (statement) => statement.type === 'IfStatement' && containsNodeType(statement.consequent, 'ThrowStatement')
  );
  if (
    statements.length !== 4 ||
    statements[3] !== rejectingGuard ||
    !popupUrlIsExact ||
    !extensionOriginIsExact ||
    !reportedUrlsIsExact ||
    containsNodeType(functionNode.body, 'ReturnStatement') ||
    containsBooleanLiteral(rejectingGuard?.test, false)
  ) {
    return false;
  }
  const rejectionTerms = flattenLogicalOr(rejectingGuard.test).map((term) =>
    compactNodeText(term, sourceFile).replaceAll('"', "'")
  );
  return sameStrings(rejectionTerms, [
    'sender?.id!==chrome.runtime.id',
    'sender?.tab!=null',
    'sender?.origin!=null&&sender.origin!==extensionOrigin',
    'reportedUrls.length===0',
    'reportedUrls.some((value)=>value!==popupUrl)'
  ]);
}

function internalArmedCleanupHelperIsClosed(functionNode, sourceFile) {
  const parametersAreExact = sameStrings(
    functionNode.params?.map((parameter) => (parameter.type === 'Identifier' ? parameter.name : null)),
    ['message', 'sender', 'internalContext']
  );
  const statements = [...(functionNode.body?.body || [])];
  if (
    !parametersAreExact ||
    statements.length !== 2 ||
    statements[0].type !== 'VariableDeclaration' ||
    statements[0].kind !== 'const' ||
    statements[1].type !== 'ReturnStatement'
  ) {
    return false;
  }
  const declarations = statements[0].declarations;
  if (declarations.length !== 1 || propertyName(declarations[0].id) !== 'expectedApprovalHandoffNonce') {
    return false;
  }
  const nonceInitializer = compactNodeText(declarations[0].init, sourceFile).replaceAll('"', "'");
  if (nonceInitializer !== "String(internalContext?.expectedApprovalHandoffNonce||'')") return false;
  const returned = unwrapExpression(statements[1].argument);
  if (!returned || returned.type !== 'CallExpression' || memberPath(returned.callee) !== 'Boolean') {
    return false;
  }
  const booleanArgument = unwrapExpression(returned.arguments[0]);
  const terms = flattenLogicalAnd(booleanArgument);
  if (terms.length !== 5 || containsCallerPayloadDataflow(functionNode.body)) {
    return false;
  }
  const termTexts = terms.map((term) => compactNodeText(term, sourceFile).replaceAll('"', "'"));
  const requiredTerms = [
    (text) => text === 'message?.type===MESSAGE_TYPES.runDeepClean',
    (text) => text === '/^[a-f0-9]{48}$/.test(expectedApprovalHandoffNonce)',
    (text) => text === 'sender?.id===chrome.runtime.id',
    (text) => text === 'sender?.tab==null',
    (text) => text === "getExtensionSenderUrl(sender)===chrome.runtime.getURL('background/service-worker.js')"
  ];
  return requiredTerms.every((matches) => termTexts.some(matches));
}

function validatePopupCapabilityMintAndBindingSemantics(source, findings) {
  const sourceFile = parseJavaScriptSource('src/background/cleanup-preflight.js', source, findings);
  if (!sourceFile) return;
  const mint = findNamedFunction(sourceFile, 'randomPopupPreparationCapability');
  const bytes = mint ? findVariableDeclaration(mint, 'bytes') : null;
  const allocation = unwrapExpression(bytes?.init);
  const allocationIs256Bits = Boolean(
    allocation &&
    allocation.type === 'NewExpression' &&
    memberPath(allocation.callee) === 'Uint8Array' &&
    numericLiteralValue(allocation.arguments?.[0]) === 32
  );
  const cryptoFillStatement = mint?.body?.body.find((statement) => {
    const call = directCallFromStatement(statement);
    return (
      memberPath(call?.callee) === 'globalThis.crypto.getRandomValues' && memberPath(call.arguments[0]) === 'bytes'
    );
  });
  const deterministicFill = mint ? findCallExpression(mint, (call) => memberPath(call.callee).endsWith('.fill')) : null;
  const mintReturn = mint?.body?.body.find((statement) => statement.type === 'ReturnStatement');
  const returnIsExactEncoding =
    compactNodeText(mintReturn?.argument, sourceFile).replaceAll('"', "'") ===
    "[...bytes].map((value)=>value.toString(16).padStart(2,'0')).join('')";
  if (
    !mint ||
    !allocationIs256Bits ||
    mint.body.body.length !== 3 ||
    mint.body.body[0]?.type !== 'VariableDeclaration' ||
    mint.body.body[1] !== cryptoFillStatement ||
    mint.body.body[2] !== mintReturn ||
    !cryptoFillStatement ||
    deterministicFill ||
    !mintReturn ||
    cryptoFillStatement.start >= mintReturn.start ||
    !returnIsExactEncoding
  ) {
    findings.push(
      'src/background/cleanup-preflight.js: the 256-bit popup capability must be filled by crypto.getRandomValues before encoding'
    );
  }

  const contextNormalizer = findNamedFunction(sourceFile, 'normalizePopupContextId');
  if (!contextNormalizer || !popupContextNormalizerIsExact(contextNormalizer, sourceFile)) {
    findings.push(
      'src/background/cleanup-preflight.js: popup context normalization must preserve the exact opaque nonempty Chrome context ID'
    );
  }

  const digestHelper = findNamedFunction(sourceFile, 'digestCleanupPopupPreparationCapability');
  if (!digestHelper || !popupCapabilityDigestHelperIsExact(digestHelper, sourceFile)) {
    findings.push(
      'src/background/cleanup-preflight.js: popup preparation capabilities must be validated and reduced only through SHA-256'
    );
  }

  const consumeHelper = findNamedFunction(sourceFile, 'consumeCleanupReviewRequest');
  if (!consumeHelper || !cleanupConsumptionBindingIsExact(consumeHelper)) {
    findings.push(
      'src/background/cleanup-preflight.js: atomic cleanup consumption must enforce popup binding whenever the worker requires it'
    );
  }

  const binding = findNamedFunction(sourceFile, 'assertCleanupReviewPopupBinding');
  if (!binding || !popupBindingHelperIsRestrictive(binding, sourceFile)) {
    findings.push(
      'src/background/cleanup-preflight.js: assertCleanupReviewPopupBinding must compare exact context and SHA-256 digest in constant time'
    );
  }
}

function popupContextNormalizerIsExact(functionNode, sourceFile) {
  const statements = functionNode.body?.body || [];
  const guard = statements[0];
  const successfulReturn = statements[1];
  const rejectionTerms =
    guard?.type === 'IfStatement'
      ? flattenLogicalOr(guard.test).map((term) => compactNodeText(term, sourceFile).replaceAll('"', "'"))
      : [];
  return Boolean(
    statements.length === 2 &&
    guard?.type === 'IfStatement' &&
    sameStrings(rejectionTerms, ["typeofvalue!=='string'", 'value!==value.trim()', '!value', 'value.length>256']) &&
    guard.consequent?.type === 'ReturnStatement' &&
    guard.consequent.argument?.type === 'Literal' &&
    guard.consequent.argument.value === null &&
    successfulReturn?.type === 'ReturnStatement' &&
    memberPath(successfulReturn.argument) === 'value'
  );
}

function popupCapabilityDigestHelperIsExact(functionNode, sourceFile) {
  const statements = functionNode.body?.body || [];
  const capability = statements[0]?.declarations?.[0];
  const malformedGuard = statements[1];
  const cryptoGuard = statements[2];
  const digest = statements[3]?.declarations?.[0];
  const digestInitializer = compactNodeText(digest?.init, sourceFile).replaceAll('"', "'");
  const encodedReturn = compactNodeText(statements[4]?.argument, sourceFile).replaceAll('"', "'");
  return Boolean(
    statements.length === 5 &&
    propertyName(capability?.id) === 'capability' &&
    compactNodeText(capability?.init, sourceFile).replaceAll('"', "'") === "typeofvalue==='string'?value.trim():''" &&
    malformedGuard?.type === 'IfStatement' &&
    compactNodeText(malformedGuard.test, sourceFile) === '!POPUP_PREPARATION_CAPABILITY_PATTERN.test(capability)' &&
    containsNodeType(malformedGuard.consequent, 'ThrowStatement') &&
    cryptoGuard?.type === 'IfStatement' &&
    compactNodeText(cryptoGuard.test, sourceFile) === '!globalThis.crypto?.subtle?.digest' &&
    containsNodeType(cryptoGuard.consequent, 'ThrowStatement') &&
    propertyName(digest?.id) === 'digest' &&
    digestInitializer === "awaitglobalThis.crypto.subtle.digest('SHA-256',newTextEncoder().encode(capability))" &&
    statements[4]?.type === 'ReturnStatement' &&
    encodedReturn === "[...newUint8Array(digest)].map((byte)=>byte.toString(16).padStart(2,'0')).join('')"
  );
}

function cleanupConsumptionBindingIsExact(functionNode) {
  const guard = functionNode.body?.body.find(
    (statement) =>
      statement.type === 'IfStatement' &&
      isBooleanFlagComparison(statement.test, 'dependencies.requirePopupPreparationCapability', '===', true)
  );
  const guardStatements = guard?.consequent?.type === 'BlockStatement' ? guard.consequent.body : [];
  const bindingCall = guardStatements.length === 1 ? directCallFromStatement(guardStatements[0]) : null;
  return Boolean(
    guard &&
    bindingCall &&
    callName(bindingCall) === 'assertCleanupReviewPopupBinding' &&
    sameStrings(bindingCall.arguments.map(memberPath), ['record', 'payload'])
  );
}

function popupBindingHelperIsRestrictive(functionNode, sourceFile) {
  const bodyText = compactNodeText(functionNode.body, sourceFile);
  const statements = functionNode.body?.body || [];
  const popupContext = findVariableDeclaration(functionNode, 'popupContextId', {
    directStatementsOnly: true
  });
  const expectedDigest = findVariableDeclaration(functionNode, 'expectedDigest', {
    directStatementsOnly: true
  });
  const popupContextIsExact =
    compactNodeText(popupContext?.init, sourceFile) === 'normalizePopupContextId(payload.popupContextId)';
  const expectedDigestIsExact =
    compactNodeText(expectedDigest?.init, sourceFile) ===
    'normalizePopupCapabilityDigest(record?.popupPreparationCapabilityDigest)';
  const contextGuard = statements.find(
    (statement) =>
      statement.type === 'IfStatement' &&
      compactNodeText(statement.test, sourceFile).includes('popupContextId!==record.preparationContextId') &&
      containsNodeType(statement.consequent, 'ThrowStatement')
  );
  const contextGuardTerms = contextGuard
    ? flattenLogicalOr(contextGuard.test).map((term) => compactNodeText(term, sourceFile))
    : [];
  const actualDigest = findVariableDeclaration(functionNode, 'actualDigest', { directStatementsOnly: true });
  const rawCapabilityDigested = Boolean(
    actualDigest?.init &&
    findCallExpression(
      actualDigest.init,
      (call) =>
        memberPath(call.callee) === 'digestCleanupPopupPreparationCapability' &&
        memberPath(call.arguments[0]) === 'payload.popupPreparationCapability'
    )
  );
  const difference = findVariableDeclaration(functionNode, 'difference', { directStatementsOnly: true });
  const loop = statements.find((statement) => statement.type === 'ForStatement');
  const constantTimeAssignment = loop
    ? findNode(
        loop.body,
        (node) =>
          node.type === 'AssignmentExpression' &&
          node.operator === '|=' &&
          memberPath(node.left) === 'difference' &&
          node.right?.type === 'BinaryExpression' &&
          node.right.operator === '^' &&
          compactNodeText(node.right, sourceFile).includes('expectedDigest.charCodeAt(index)') &&
          compactNodeText(node.right, sourceFile).includes('actualDigest.charCodeAt(index)')
      )
    : null;
  const mismatchThrows = statements.some(
    (statement) =>
      statement.type === 'IfStatement' &&
      compactNodeText(statement.test, sourceFile) === 'difference!==0' &&
      containsNodeType(statement.consequent, 'ThrowStatement')
  );
  const successfulReturn = statements[7];
  return Boolean(
    statements.length === 8 &&
    statements[0]?.type === 'VariableDeclaration' &&
    statements[1]?.type === 'VariableDeclaration' &&
    statements[2] === contextGuard &&
    statements[3]?.type === 'VariableDeclaration' &&
    statements[4]?.type === 'VariableDeclaration' &&
    statements[5] === loop &&
    statements[6]?.type === 'IfStatement' &&
    successfulReturn?.type === 'ReturnStatement' &&
    successfulReturn.argument?.type === 'Literal' &&
    successfulReturn.argument.value === true &&
    contextGuard &&
    sameStrings(contextGuardTerms, [
      '!record',
      '!popupContextId',
      'popupContextId!==record.preparationContextId',
      '!expectedDigest'
    ]) &&
    popupContextIsExact &&
    expectedDigestIsExact &&
    bodyText.includes('!record') &&
    bodyText.includes('!popupContextId') &&
    bodyText.includes('!expectedDigest') &&
    bodyText.includes('record?.popupPreparationCapabilityDigest') &&
    rawCapabilityDigested &&
    numericLiteralValue(difference?.init) === 0 &&
    loop &&
    compactNodeText(loop.init, sourceFile) === 'letindex=0' &&
    compactNodeText(loop.test, sourceFile) === 'index<expectedDigest.length' &&
    compactNodeText(loop.update, sourceFile) === 'index+=1' &&
    loop.body?.type === 'BlockStatement' &&
    loop.body.body.length === 1 &&
    constantTimeAssignment &&
    mismatchThrows &&
    popupContext.start < expectedDigest.start &&
    expectedDigest.start < contextGuard.start &&
    contextGuard.start < actualDigest.start &&
    actualDigest.start < loop.start
  );
}

function validateNoRawPopupCapabilitySinks(sourceEntries, findings) {
  for (const [path, source] of sourceEntries) {
    const sourceFile = parseJavaScriptSource(path, source, findings);
    if (!sourceFile) continue;
    const taintedNames = collectRawCapabilityAliases(sourceFile);
    const persistentSinkAliases = collectPersistentSinkAliases(sourceFile);
    const leakedCall = findNode(
      sourceFile,
      (node) =>
        node.type === 'CallExpression' &&
        isPersistentOrDiagnosticSink(node.callee, sourceFile, persistentSinkAliases) &&
        node.arguments.some((argument) => containsRawCapabilityValue(argument, taintedNames))
    );
    const leakedAssignment = findNode(
      sourceFile,
      (node) =>
        node.type === 'AssignmentExpression' &&
        node.operator === '=' &&
        unwrapExpression(node.left)?.type !== 'Identifier' &&
        containsRawCapabilityValue(node.right, taintedNames)
    );
    if (leakedCall || leakedAssignment) {
      findings.push(
        `${path}: raw popup preparation capability must not enter extension storage, jobs, reports, debug logs, or other durable/diagnostic sinks`
      );
    }
  }
}

function collectRawCapabilityAliases(sourceFile) {
  const tainted = new Set(['popupPreparationCapability']);
  let changed = true;
  while (changed) {
    changed = false;
    walkNodes(sourceFile, (node) => {
      if (
        node.type === 'VariableDeclarator' &&
        node.id?.type === 'Identifier' &&
        node.init &&
        expressionIsRawCapabilityAlias(node.init, tainted) &&
        !tainted.has(node.id.name)
      ) {
        tainted.add(node.id.name);
        changed = true;
      }
      if (
        node.type === 'VariableDeclarator' &&
        node.id?.type === 'ObjectPattern' &&
        destructuredRawCapabilityNames(node.id).some((name) => !tainted.has(name))
      ) {
        for (const name of destructuredRawCapabilityNames(node.id)) tainted.add(name);
        changed = true;
      }
      if (
        node.type === 'AssignmentExpression' &&
        node.operator === '=' &&
        unwrapExpression(node.left)?.type === 'Identifier' &&
        expressionIsRawCapabilityAlias(node.right, tainted) &&
        !tainted.has(node.left.name)
      ) {
        tainted.add(node.left.name);
        changed = true;
      }
    });
  }
  return tainted;
}

function collectPersistentSinkAliases(sourceFile) {
  const aliases = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    walkNodes(sourceFile, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id?.name) {
        const sinkCall = singleCallFromFunctionBody(node);
        if (
          sinkCall &&
          isPersistentOrDiagnosticSink(sinkCall.callee, sourceFile, aliases) &&
          !aliases.has(node.id.name)
        ) {
          aliases.add(node.id.name);
          changed = true;
        }
      }
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
        const initializer = unwrapExpression(node.init);
        const wrapperCall = ['ArrowFunctionExpression', 'FunctionExpression'].includes(initializer?.type)
          ? singleCallFromFunctionBody(initializer)
          : null;
        const boundTarget =
          initializer?.type === 'CallExpression' && staticPropertyName(initializer.callee) === 'bind'
            ? initializer.callee.object
            : initializer;
        if (
          (isPersistentOrDiagnosticSink(boundTarget, sourceFile, aliases) ||
            (wrapperCall && isPersistentOrDiagnosticSink(wrapperCall.callee, sourceFile, aliases))) &&
          !aliases.has(node.id.name)
        ) {
          aliases.add(node.id.name);
          changed = true;
        }
      }
      if (
        node.type === 'VariableDeclarator' &&
        node.id?.type === 'ObjectPattern' &&
        compactNodeText(node.init, sourceFile).toLowerCase().includes('storage')
      ) {
        for (const property of node.id.properties) {
          if (property.type !== 'Property' || propertyName(property.key) !== 'set') continue;
          const localName = property.value?.type === 'Identifier' ? property.value.name : null;
          if (localName && !aliases.has(localName)) {
            aliases.add(localName);
            changed = true;
          }
        }
      }
    });
  }
  return aliases;
}

function singleCallFromFunctionBody(functionNode) {
  const body = functionNode?.body;
  if (!body) return null;
  if (body.type !== 'BlockStatement') {
    const expression = unwrapExpression(body);
    return expression?.type === 'CallExpression' ? expression : null;
  }
  if (body.body.length !== 1) return null;
  const onlyStatement = body.body[0];
  if (onlyStatement.type === 'ReturnStatement') {
    const expression = unwrapExpression(onlyStatement.argument);
    return expression?.type === 'CallExpression' ? expression : null;
  }
  return directCallFromStatement(onlyStatement);
}

function isPersistentOrDiagnosticSink(expression, sourceFile, sinkAliases = new Set()) {
  const unwrapped = unwrapExpression(expression);
  if (unwrapped?.type === 'Identifier' && sinkAliases.has(unwrapped.name)) return true;
  const callee = compactNodeText(expression, sourceFile).toLowerCase();
  const staticCallee = memberPath(expression).toLowerCase();
  const finalName = (staticCallee || callee).split('.').at(-1)?.replaceAll('?', '') || '';
  if (finalName === 'set' && !staticCallee.includes('popuppreparationbindings')) return true;
  if (
    expression?.type === 'CallExpression' &&
    memberPath(expression.callee) === 'Reflect.get' &&
    evaluateStaticString(expression.arguments?.[1]) === 'set' &&
    compactNodeText(expression.arguments?.[0], sourceFile).toLowerCase().includes('storage')
  ) {
    return true;
  }
  if (staticCallee.startsWith('console.')) return true;
  if (
    /(?:debug|log|report)/.test(staticCallee || callee) &&
    /^(?:add|append|push|record|save|set|write)$/.test(finalName)
  )
    return true;
  return new Set([
    'appenddebug',
    'savereport',
    'setactivejob',
    'mutateactivejob',
    'setactiveshield',
    'mutateactiveshield',
    'setlastmaintenance',
    'savesettings',
    'recordcompletionwarning'
  ]).has(finalName);
}

function containsRawCapabilityValue(node, taintedNames) {
  return containsRawCapabilityValueInner(node, taintedNames, null);
}

function containsRawCapabilityValueInner(node, taintedNames, parent) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'CallExpression' && memberPath(node.callee) === 'createPromptTombstoneRecord') {
    return false;
  }
  if (node.type === 'Identifier' && taintedNames.has(node.name)) {
    if (parent?.type === 'MemberExpression' && parent.object === node) {
      return staticPropertyName(parent) === 'popupPreparationCapability';
    }
    if (parent?.type === 'Property' && parent.key === node && !parent.computed) return false;
    return true;
  }
  if (node.type === 'MemberExpression' && staticPropertyName(node) === 'popupPreparationCapability') {
    return true;
  }
  if (node.type === 'Property' && propertyName(node.key) === 'popupPreparationCapability') return true;
  if (evaluateStaticString(node) === 'popupPreparationCapability') return true;
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'loc' ||
      key === 'range' ||
      key === 'parent' ||
      key === 'comments' ||
      key === 'tokens' ||
      key === '__sourceText'
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.some((child) => containsRawCapabilityValueInner(child, taintedNames, node))) return true;
    } else if (containsRawCapabilityValueInner(value, taintedNames, node)) {
      return true;
    }
  }
  return false;
}

function expressionIsRawCapabilityAlias(node, taintedNames) {
  const expression = unwrapExpression(node);
  if (!expression) return false;
  if (expression.type === 'Identifier') return taintedNames.has(expression.name);
  if (expression.type === 'MemberExpression') {
    return staticPropertyName(expression) === 'popupPreparationCapability';
  }
  if (expression.type === 'ObjectExpression') {
    return expression.properties.some((property) => {
      if (property.type === 'SpreadElement') {
        return expressionIsRawCapabilityAlias(property.argument, taintedNames);
      }
      return (
        propertyName(property.key) === 'popupPreparationCapability' ||
        evaluateStaticString(property.key) === 'popupPreparationCapability' ||
        expressionIsRawCapabilityAlias(property.value, taintedNames)
      );
    });
  }
  if (expression.type === 'ArrayExpression') {
    return expression.elements.some((element) => expressionIsRawCapabilityAlias(element, taintedNames));
  }
  if (expression.type === 'TemplateLiteral') {
    return expression.expressions.some((part) => expressionIsRawCapabilityAlias(part, taintedNames));
  }
  if (['ConditionalExpression', 'LogicalExpression', 'BinaryExpression'].includes(expression.type)) {
    return ['left', 'right', 'consequent', 'alternate'].some((key) =>
      expressionIsRawCapabilityAlias(expression[key], taintedNames)
    );
  }
  if (expression.type === 'CallExpression') {
    const transparentCallee = memberPath(expression.callee);
    if (
      transparentCallee === 'Reflect.get' &&
      evaluateStaticString(expression.arguments?.[1]) === 'popupPreparationCapability'
    ) {
      return true;
    }
    if (!['String', 'Object.freeze', 'structuredClone', 'JSON.stringify'].includes(transparentCallee)) {
      return false;
    }
    return expression.arguments.some((argument) => expressionIsRawCapabilityAlias(argument, taintedNames));
  }
  return false;
}

function parseJavaScriptSource(path, source, findings) {
  if (typeof source !== 'string') return null;
  let sourceFile = null;
  const captureAstRule = {
    create() {
      return {
        Program(node) {
          sourceFile = node;
        }
      };
    }
  };
  const messages = publicationContractParser.verify(
    source,
    {
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      plugins: { contract: { rules: { 'capture-ast': captureAstRule } } },
      rules: { 'contract/capture-ast': 'error' }
    },
    { filename: path }
  );
  if (sourceFile && !messages.some((message) => message.fatal)) {
    Object.defineProperty(sourceFile, '__sourceText', { value: source });
    return sourceFile;
  }
  findings.push(`${path}: source cannot be parsed for publication-contract validation`);
  return null;
}

function walkNodes(node, visitor) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visitor(node);
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'loc' ||
      key === 'range' ||
      key === 'parent' ||
      key === 'comments' ||
      key === 'tokens' ||
      key === '__sourceText'
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) walkNodes(child, visitor);
    } else {
      walkNodes(value, visitor);
    }
  }
}

function findNode(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  let found = null;
  walkNodes(node, (child) => {
    if (!found && child !== node && predicate(child)) found = child;
  });
  return found;
}

function findNamedFunction(sourceFile, name) {
  return findNode(
    sourceFile,
    (node) => node.type === 'FunctionDeclaration' && node.id?.type === 'Identifier' && node.id.name === name
  );
}

function findCaseClause(sourceFile, expressionText) {
  return findNode(
    sourceFile,
    (node) => node.type === 'SwitchCase' && compactNodeText(node.test, sourceFile) === expressionText
  );
}

function caseStatements(caseClause) {
  if (!caseClause) return [];
  if (caseClause.consequent.length === 1 && caseClause.consequent[0].type === 'BlockStatement') {
    return caseClause.consequent[0].body;
  }
  return caseClause.consequent;
}

function findVariableDeclaration(node, name, { directStatementsOnly = false } = {}) {
  if (directStatementsOnly && node?.type === 'BlockStatement') {
    for (const statement of node.body) {
      if (statement.type !== 'VariableDeclaration') continue;
      const declaration = statement.declarations.find(
        (candidate) => candidate.id?.type === 'Identifier' && candidate.id.name === name
      );
      if (declaration) return declaration;
    }
    return null;
  }
  return findNode(
    node,
    (candidate) =>
      candidate.type === 'VariableDeclarator' && candidate.id?.type === 'Identifier' && candidate.id.name === name
  );
}

function findCallExpression(node, predicate) {
  return findNode(node, (candidate) => candidate.type === 'CallExpression' && predicate(candidate));
}

function containsCallNamed(node, name) {
  return Boolean(findCallExpression(node, (call) => callName(call) === name));
}

function callName(call) {
  if (!call || call.type !== 'CallExpression') return '';
  const path = memberPath(call.callee);
  return path.split('.').at(-1) || '';
}

function directCallFromStatement(statement) {
  if (!statement) return null;
  if (statement.type === 'BlockStatement' && statement.body.length === 1) {
    return directCallFromStatement(statement.body[0]);
  }
  if (statement.type !== 'ExpressionStatement') return null;
  const expression = unwrapExpression(statement.expression);
  return expression?.type === 'CallExpression' ? expression : null;
}

function unwrapExpression(node) {
  let current = node || null;
  while (
    current &&
    (current.type === 'ChainExpression' ||
      current.type === 'AwaitExpression' ||
      (current.type === 'UnaryExpression' && current.operator === 'void'))
  ) {
    current = current.expression || current.argument;
  }
  return current;
}

function compactNodeText(node, sourceFile) {
  if (!node) return '';
  const source = sourceFile?.__sourceText || '';
  return source
    .slice(node.start, node.end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '')
    .replace(/\s+/g, '');
}

function stringArrayValues(node) {
  const expression = unwrapExpression(node);
  if (!expression || expression.type !== 'ArrayExpression') return null;
  const values = expression.elements.map(stringLiteralValue);
  return values.every((value) => value !== null) ? values : null;
}

function stringLiteralValue(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

function numericLiteralValue(node) {
  const expression = unwrapExpression(node);
  return expression?.type === 'Literal' && typeof expression.value === 'number' ? expression.value : null;
}

function propertyName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return '';
}

function containsNodeType(node, type) {
  return Boolean(findNode(node, (candidate) => candidate.type === type));
}

function containsBooleanLiteral(node, value) {
  return Boolean(findNode(node, (candidate) => candidate.type === 'Literal' && candidate.value === value));
}

function containsCallerPayloadDataflow(node) {
  return Boolean(
    findNode(node, (candidate) => {
      if (candidate.type === 'Identifier' && candidate.name === 'payload') return true;
      if (candidate.type === 'MemberExpression' && staticPropertyName(candidate) === 'payload') return true;
      return evaluateStaticString(candidate) === 'payload';
    })
  );
}

function flattenLogicalAnd(node) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'LogicalExpression' && expression.operator === '&&') {
    return [...flattenLogicalAnd(expression.left), ...flattenLogicalAnd(expression.right)];
  }
  return expression ? [expression] : [];
}

function flattenLogicalOr(node) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'LogicalExpression' && expression.operator === '||') {
    return [...flattenLogicalOr(expression.left), ...flattenLogicalOr(expression.right)];
  }
  return expression ? [expression] : [];
}

function isBooleanFlagComparison(node, path, operator, value) {
  const expression = unwrapExpression(node);
  return Boolean(
    expression?.type === 'BinaryExpression' &&
    expression.operator === operator &&
    memberPath(expression.left) === path &&
    expression.right?.type === 'Literal' &&
    expression.right.value === value
  );
}

function isExactBinaryComparison(node, leftPath, operator, rightValue) {
  const expression = unwrapExpression(node);
  return Boolean(
    expression?.type === 'BinaryExpression' &&
    expression.operator === operator &&
    memberPath(expression.left) === leftPath &&
    expression.right?.type === 'Literal' &&
    expression.right.value === rightValue
  );
}

function isExactMemberComparison(node, leftPath, operator, rightPath) {
  const expression = unwrapExpression(node);
  return Boolean(
    expression?.type === 'BinaryExpression' &&
    expression.operator === operator &&
    memberPath(expression.left) === leftPath &&
    memberPath(expression.right) === rightPath
  );
}

function isExactAssignment(node, leftPath, rightValue) {
  const expression = unwrapExpression(node);
  return Boolean(
    expression?.type === 'AssignmentExpression' &&
    expression.operator === '=' &&
    memberPath(expression.left) === leftPath &&
    expression.right?.type === 'Literal' &&
    expression.right.value === rightValue
  );
}

function isExactCallAssignment(node, leftPath, calleePath, argumentPath) {
  const expression = unwrapExpression(node);
  const call = unwrapExpression(expression?.right);
  return Boolean(
    expression?.type === 'AssignmentExpression' &&
    expression.operator === '=' &&
    memberPath(expression.left) === leftPath &&
    call?.type === 'CallExpression' &&
    memberPath(call.callee) === calleePath &&
    call.arguments.length === 1 &&
    memberPath(call.arguments[0]) === argumentPath
  );
}

function isNegatedIdentifier(node, name) {
  const expression = unwrapExpression(node);
  return Boolean(
    expression?.type === 'UnaryExpression' &&
    expression.operator === '!' &&
    expression.argument?.type === 'Identifier' &&
    expression.argument.name === name
  );
}

function isUnknownKeyFilter(node) {
  const expression = unwrapExpression(node);
  if (expression?.type !== 'CallExpression' || staticPropertyName(expression.callee) !== 'filter') return false;
  const objectKeysCall = unwrapExpression(expression.callee.object);
  if (
    objectKeysCall?.type !== 'CallExpression' ||
    memberPath(objectKeysCall.callee) !== 'Object.keys' ||
    memberPath(objectKeysCall.arguments?.[0]) !== 'value'
  ) {
    return false;
  }
  const callback = expression.arguments?.[0];
  if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type)) return false;
  const keyName = callback.params?.[0]?.type === 'Identifier' ? callback.params[0].name : null;
  const body = unwrapExpression(callback.body);
  const denied =
    unwrapExpression(body)?.type === 'UnaryExpression' && unwrapExpression(body).operator === '!'
      ? unwrapExpression(body).argument
      : null;
  return Boolean(
    keyName &&
    denied?.type === 'CallExpression' &&
    memberPath(denied.callee) === 'allowed.has' &&
    denied.arguments?.[0]?.type === 'Identifier' &&
    denied.arguments[0].name === keyName
  );
}

function isNonemptyArrayTest(node, name) {
  const expression = unwrapExpression(node);
  if (memberPath(expression) === `${name}.length`) return true;
  if (expression?.type !== 'BinaryExpression') return false;
  const left = memberPath(expression.left);
  const right = numericLiteralValue(expression.right);
  return (
    left === `${name}.length` &&
    ((expression.operator === '>' && right === 0) || (expression.operator === '!==' && right === 0))
  );
}

function memberPath(node) {
  const expression = unwrapExpression(node);
  if (!expression) return '';
  if (expression.type === 'Identifier') return expression.name;
  if (expression.type !== 'MemberExpression') return '';
  const object = memberPath(expression.object);
  const property = staticPropertyName(expression);
  return object && property ? `${object}.${property}` : '';
}

function staticPropertyName(member) {
  if (member?.type !== 'MemberExpression') return '';
  if (!member.computed && member.property?.type === 'Identifier') return member.property.name;
  return evaluateStaticString(member.property) || '';
}

function evaluateStaticString(node) {
  const expression = unwrapExpression(node);
  if (!expression) return null;
  if (expression.type === 'Literal' && typeof expression.value === 'string') return expression.value;
  if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
    return expression.quasis[0]?.value?.cooked ?? null;
  }
  if (expression.type === 'BinaryExpression' && expression.operator === '+') {
    const left = evaluateStaticString(expression.left);
    const right = evaluateStaticString(expression.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function nodeContains(node, target) {
  return Boolean(findNode(node, (candidate) => candidate === target));
}

function destructuredRawCapabilityNames(pattern) {
  if (pattern?.type !== 'ObjectPattern') return [];
  const names = [];
  for (const property of pattern.properties) {
    if (
      property.type !== 'Property' ||
      ![propertyName(property.key), evaluateStaticString(property.key)].includes('popupPreparationCapability')
    ) {
      continue;
    }
    if (property.value?.type === 'Identifier') names.push(property.value.name);
    if (property.value?.type === 'AssignmentPattern' && property.value.left?.type === 'Identifier') {
      names.push(property.value.left.name);
    }
  }
  return names;
}

function sourceRange(source, startMarker, endMarker) {
  if (typeof source !== 'string') return '';
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? '' : source.slice(start, end);
}

function validatePromptTerminalReplayOrdering(preflightSource, leaseSource, workerSource, findings) {
  const reviewRetirement = sourceRange(
    preflightSource,
    'async function removeReviewAndReleaseUnlessPromptOwnerArrived(',
    'function notifyPromptTombstoneRestored('
  );
  const reviewRelease = sourceRange(
    preflightSource,
    'async function releaseTemporaryReviewAccess(',
    'export function getTemporaryReviewHostPermissionOrigins('
  );
  const leaseReconciliation = sourceRange(
    leaseSource,
    'export async function reconcilePermissionLease(',
    'async function retainLease('
  );
  const tombstoneSettlement = sourceRange(
    workerSource,
    'async function settleOwnedCleanupPromptTombstone(',
    'async function settleCleanupPromptAtBrowserSessionBoundary('
  );
  const promptSettlement = sourceRange(
    workerSource,
    'async function settleCleanupPermissionPromptByLeaseId(',
    'async function recoverOrphanedNonResumableCleanupHandoff('
  );
  const terminalWrite = sourceRange(
    workerSource,
    'async function rememberCleanupPermissionHandoffTerminalResult(',
    'function normalizeCleanupPermissionHandoffRecord('
  );
  const compactReviewRetirement = reviewRetirement.replaceAll(/\s/g, '');
  const compactReviewRelease = reviewRelease.replaceAll(/\s/g, '');
  const compactLeaseReconciliation = leaseReconciliation.replaceAll(/\s/g, '');
  const compactTombstoneSettlement = tombstoneSettlement.replaceAll(/\s/g, '');
  const compactPromptSettlement = promptSettlement.replaceAll(/\s/g, '');
  const compactTerminalWrite = terminalWrite.replaceAll(/\s/g, '');
  const delayedRetirementMarker = 'constretireReviewAfterSettledRelease=dependencies.promptSettled===true;';
  const releaseAt = compactReviewRetirement.indexOf('hostPermissionCleanup=awaitreleaseTemporaryReviewAccess(');
  const finalReviewRemovalAt = compactReviewRetirement.lastIndexOf(
    'awaitstorageSession.remove(CLEANUP_REVIEW_STORAGE_KEY)'
  );
  const leaseFinalizerCount = (
    compactLeaseReconciliation.match(/awaitdependencies\.beforeLeaseRemoval\(settlement\)/g) || []
  ).length;
  if (
    !compactReviewRetirement.includes(delayedRetirementMarker) ||
    releaseAt < 0 ||
    finalReviewRemovalAt <= releaseAt ||
    !compactReviewRelease.includes('beforeLeaseRemoval:dependencies.beforePermissionLeaseRemoval') ||
    leaseFinalizerCount < 4 ||
    compactLeaseReconciliation.includes(
      'awaitstorageLocal.remove(STORAGE_KEYS.permissionLease);awaitdependencies.beforeLeaseRemoval(settlement)'
    ) ||
    !compactTombstoneSettlement.includes('terminalHandoffNonce:permissionHandoff?.handoffNonce||null') ||
    !compactPromptSettlement.includes(
      'constbeforePermissionLeaseRemoval=terminalHandoffNonce?async(terminalSettlement)=>'
    ) ||
    !compactPromptSettlement.includes(
      'awaitrememberCleanupPermissionHandoffTerminalResult(terminalHandoffNonce,terminalResult)'
    ) ||
    !compactPromptSettlement.includes('beforePermissionLeaseRemoval') ||
    compactTerminalWrite.includes('returnfalse') ||
    !compactTerminalWrite.includes('constcommitted=awaitreadCleanupPermissionHandoff().catch(()=>null)') ||
    !compactTerminalWrite.includes('wasnotdurablyrecorded')
  ) {
    findings.push(
      'prompt expiry terminal cancellation must be durably recorded after exact reconciliation proof and before its owned review and lease records retire'
    );
  }
}

function quotedArrayPattern(fields) {
  return `\\[\\s*${fields.map((field) => `['"]${escapeRegExp(field)}['"]`).join('\\s*,\\s*')}\\s*\\]`;
}

function validateOwnerDecision(decision, findings, version) {
  if (
    decision?.schemaVersion !== 2 ||
    decision?.status !== 'owner_approved_design_installed_validation_pending' ||
    decision?.ownerApproved !== true ||
    decision?.settingKey !== 'skipCleanupReview' ||
    decision?.settingDisplayName !== 'Skip detailed cleanup review completely' ||
    decision?.defaultEnabled !== false ||
    !sameStrings(decision?.supportedCleanupModes, ['standard', 'expert']) ||
    decision?.approvalMode !== 'settings_direct' ||
    decision?.readOnlyPreflightStillRequired !== true ||
    decision?.readOnlyPreflightCompletesBeforeCleanNowIsEnabled !== true ||
    decision?.shortLivedSingleUseApprovalRequired !== true ||
    decision?.explicitSettingsConfirmationRequired !== true ||
    decision?.expertFileIdsRemainPreflightBound !== true ||
    decision?.expertTypedPerRunFilePhraseSkippedWhenEnabled !== true ||
    decision?.browserPermissionPromptMayRequireAdditionalInteraction !== true ||
    decision?.promptPendingRecoveryWindowMinutes !== 30 ||
    decision?.incognitoRequirements?.allowInIncognitoMustBeEnabledByUser !== true ||
    decision?.incognitoRequirements?.privateSourceRequiresPreexistingExactTargetAccess !== true ||
    decision?.incognitoRequirements?.privateSourceMayRequestMissingTargetAccess !== false ||
    decision?.installedBrowserEvidence !== 'pending'
  ) {
    findings.push(
      'docs/decisions/direct-cleanup-owner-decision.json: owner decision, default-off policy, direct/incognito limits, or pending installed-evidence state is incomplete'
    );
  }
  const activation = decision?.activationContract;
  if (
    decision?.amendedAt !== '2026-08-22' ||
    !String(decision?.amendmentOwnerStatement || '').includes('first SiteWipe activation durably records') ||
    !String(decision?.amendmentOwnerStatement || '').includes('second SiteWipe activation') ||
    decision?.reviewedVersion !== version ||
    decision?.sourceCandidatePublicationReviewApproved !== true ||
    decision?.rawCleanupRouteAuthorized !== false ||
    activation?.pregrantedExactAccessSiteWipeActivations !== 1 ||
    activation?.missingNormalWindowAccessSiteWipeActivations !== 2 ||
    activation?.firstActivationDurablyArmsReviewedApproval !== true ||
    activation?.firstActivationRequestsBrowserPermission !== false ||
    activation?.firstActivationStartsCleanup !== false ||
    activation?.firstActivationOpensOrFocusesExactWorkerCreatedHandoffTab !== true ||
    activation?.handoffTabCreatedInReviewedNormalSourceWindow !== true ||
    activation?.handoffTabCreationMayResizeSourceWindow !== false ||
    activation?.handoffTabCreatedAboutBlankAndRecordedBeforePackagedNavigation !== true ||
    activation?.actionPopupMayRequestMissingTargetAccess !== false ||
    activation?.secondActivationSurface !== 'exact_worker_created_extension_handoff_tab' ||
    activation?.secondActivationRequestsPreflightBoundExactMissingPatternsFirst !== true ||
    activation?.secondActivationDispatchesAuthenticatedNonRunnableIntentBeforePermissionRequest !== true ||
    activation?.secondActivationStartsPreRequestInventorySynchronouslyBeforePermissionRequest !== true ||
    activation?.secondActivationSynchronouslyInvokesPermissionRequestBeforeInvocationConfirmation !== true ||
    activation?.secondActivationConfirmsInvocationOnlyAfterAcceptedRequest !== true ||
    activation?.secondActivationAuthenticatesPromptInvocationWithHandoffCapability !== true ||
    activation?.secondActivationDispatchesConfirmationWithoutAwaitingNativeResult !== true ||
    activation?.workerDurablyRecordsExactPostBeginGrantObservation !== true ||
    activation?.secondActivationReportsResolvedTrueOutcomeWithHandoffCapability !== true ||
    activation?.handoffTabMustBeWorkerCreated !== true ||
    activation?.handoffTabMustMatchExactTabUrlFrameOriginAndWorkerResolvedContext !== true ||
    activation?.handoffRuntimeContextMustBeNormalTopFrameTabContext !== true ||
    activation?.approvalHandoffSchemaVersion !== 3 ||
    activation?.olderPopupHandoffSchemaMayBeRebound !== false ||
    activation?.optionalSenderDocumentIdMayBeRequired !== false ||
    activation?.optionalSenderDocumentIdMaySubstituteForContextId !== false ||
    activation?.handoffRawCapabilityMayEnterUrlHistoryOrStorage !== false ||
    activation?.directOpenDuplicateReloadNavigationOrReplacementHandoffMayContinue !== false ||
    activation?.grantOutcomeRequiresLiteralBooleanTrue !== true ||
    activation?.grantOutcomeRequiresPreRequestTemporaryOriginsAbsent !== true ||
    activation?.invalidMalformedOrCoveredPreRequestInventoryMayRecordOutcome !== false ||
    activation?.workerDurablyRecordsAuthenticatedResolvedTrueGrantOutcome !== true ||
    activation?.cleanupRequiresCompleteExactGrantObservation !== true ||
    activation?.cleanupRequiresAuthenticatedResolvedTrueGrantOutcome !== true ||
    activation?.permissionRemovalRequiresCompleteExactGrantObservation !== true ||
    activation?.permissionRemovalRequiresAuthenticatedResolvedTrueGrantOutcome !== true ||
    activation?.permissionEventsMaySynthesizePromptInvocation !== false ||
    activation?.permissionEventsMaySynthesizeGrantOutcome !== false ||
    activation?.handoffOutcomeMaySynthesizeGrantObservation !== false ||
    activation?.authenticatedResumeDiscardsUnobservedGrantAsExternal !== false ||
    activation?.unobservedGrantIsPreserved !== true ||
    activation?.handoffPageLossBeforeGrantOutcomePreservesGrant !== true ||
    activation?.handoffPageLossAfterAdmissionMayCancelAdmittedJob !== false ||
    activation?.trueOutcomeWithoutGrantEventRemainsPendingThroughLiveWindow !== true ||
    activation?.resumeRetryExhaustionMayDiscardTrueOnlyProof !== false ||
    activation?.lateExactGrantEventMayCompleteTrueOnlyProof !== true ||
    activation?.terminalIncompleteProofPreservesAccess !== true ||
    activation?.expiredPromptTerminalResultSurvivesServiceWorkerRestart !== true ||
    activation?.terminalResultRecordedBeforeOwnedReviewAndLeaseRetirement !== true ||
    activation?.permissionLeaseSchemaVersion !== 3 ||
    activation?.reviewedPromptGrantOwnershipRequiresCompleteHandoffProof !== true ||
    activation?.activeCleanupOwnershipRequiresReviewedPromptGrantProof !== true ||
    activation?.releasePendingRetainsOwnershipProof !== true ||
    activation?.startupMayRemoveOnlyReviewedOrAdmittedOwnedAccess !== true ||
    activation?.legacyProoflessOrRevokedLeasePreservesAccess !== true ||
    activation?.intersectingPermissionRemovalRevokesOwnership !== true ||
    activation?.permissionRemovalInvalidatesPendingReviewAuthority !== true ||
    activation?.laterManualRegrantMayReuseRevokedOwnership !== false ||
    activation?.promptIntentConfirmationGraceSeconds !== 30 ||
    activation?.confirmationAlarmIsSeparateFromReviewExpiry !== true ||
    activation?.reviewExpiryMinutes !== 5 ||
    activation?.unconfirmedIntentTombstoneIsNonRunnable !== true ||
    activation?.confirmedIntentTombstoneBecomesPromptTombstone !== true ||
    activation?.synchronousRequestThrowUsesAuthenticatedNotInvokedSettlement !== true ||
    activation?.workerPersistsPromptInvocationBeforeRedrive !== true ||
    activation?.promptInvocationRequiredForAdmission !== true ||
    activation?.resumeMaySynthesizePromptInvocation !== false ||
    activation?.uninvokedOrManualGrantMayStartCleanup !== false ||
    activation?.uninvokedOrManualGrantMayBeAutomaticallyRemoved !== false ||
    activation?.secondActivationRunsOnlyAfterExactGrantAndFullRevalidation !== true ||
    activation?.exactBoundHandoffDocumentRequired !== true ||
    activation?.oneNonceMayAdmitAtMostOneCleanup !== true
  ) {
    findings.push(DIRECT_CLEANUP_OWNER_AMENDMENT_FINDING);
  }
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value, index) => actual[index] === value)
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
