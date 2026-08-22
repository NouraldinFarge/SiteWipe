import { Linter } from 'eslint';

const publicationContractParser = new Linter({ configType: 'flat' });

export const DIRECT_CLEANUP_CONTRACT_FILES = Object.freeze([
  'src/background/cleanup-authorization.js',
  'src/background/cleanup-preflight.js',
  'src/background/permission-leases.js',
  'src/background/service-worker.js',
  'src/options/options.html',
  'src/options/options.js',
  'src/popup/popup.js',
  'src/shared/cleanup-review.js',
  'src/shared/constants.js',
  'src/shared/message-contracts.js',
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
export function findDirectCleanupPublicationContractFindings({ sources = {}, decision = null } = {}) {
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

  validateOwnerDecision(decision, findings);

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
    const permissionRequestAt = popupSource.indexOf('chrome.permissions.request({ origins })');
    const cleanupSubmissionAt = popupSource.indexOf('sendMessage(MESSAGE_TYPES.runDeepClean', permissionRequestAt);
    if (permissionRequestAt < 0 || cleanupSubmissionAt < 0 || permissionRequestAt >= cleanupSubmissionAt) {
      findings.push(
        'src/popup/popup.js: a missing normal-window permission request must precede cleanup submission from the prepared activation'
      );
    }
  }

  const messageContractSource = requireSource('src/shared/message-contracts.js');
  if (messageContractSource) validateRunDeepCleanMessageContract(messageContractSource, findings);
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
  validatePopupCapabilityMintAndBindingSemantics(requireSource('src/background/cleanup-preflight.js'), findings);
  validateNoRawPopupCapabilitySinks(
    [
      ['src/background/cleanup-preflight.js', requireSource('src/background/cleanup-preflight.js')],
      ['src/background/service-worker.js', requireSource('src/background/service-worker.js')],
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
  }

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

function quotedArrayPattern(fields) {
  return `\\[\\s*${fields.map((field) => `['"]${escapeRegExp(field)}['"]`).join('\\s*,\\s*')}\\s*\\]`;
}

function validateOwnerDecision(decision, findings) {
  if (
    decision?.status !== 'owner_approved_design_installed_validation_pending' ||
    decision?.ownerApproved !== true ||
    decision?.settingKey !== 'skipCleanupReview' ||
    decision?.settingDisplayName !== 'Skip detailed cleanup review completely' ||
    decision?.defaultEnabled !== false ||
    !sameStrings(decision?.supportedCleanupModes, ['standard', 'expert']) ||
    decision?.approvalMode !== 'settings_direct' ||
    decision?.onePopupCleanupAction !== true ||
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
