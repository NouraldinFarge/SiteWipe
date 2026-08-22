function buildNamedPermissionRequest(permission) {
  const name = String(permission || '').trim();
  if (!name) throw new Error('Optional permission name is unavailable.');
  return { permissions: [name] };
}

function assertPermissionApi(permissionsApi, methods) {
  for (const method of methods) {
    if (typeof permissionsApi?.[method] !== 'function') {
      throw new Error(`Optional permission ${method} inspection is unavailable.`);
    }
  }
}

/**
 * Observes optional named-permission state outside a user gesture. A false
 * observation is deliberately not treated as proof that a later request
 * created the grant: permission state can change between refresh and click.
 */
export async function observeOptionalPermission(permission, permissionsApi = chrome.permissions) {
  const request = buildNamedPermissionRequest(permission);
  try {
    assertPermissionApi(permissionsApi, ['contains']);
    return Boolean(await permissionsApi.contains(request));
  } catch {
    return null;
  }
}

/**
 * Requests an optional named permission as the first asynchronous browser API
 * call in the click path. Awaiting contains() here can consume Chrome's user
 * activation before the native prompt opens, so any earlier observation is
 * advisory and ambiguous unless it proved the permission was already present.
 */
export async function requestOptionalPermissionWithProvenance(
  permission,
  { observedBeforeGesture = null, permissionsApi = chrome.permissions } = {}
) {
  assertPermissionApi(permissionsApi, ['request']);
  const request = buildNamedPermissionRequest(permission);
  const granted = Boolean(await permissionsApi.request(request));
  const observation = typeof observedBeforeGesture === 'boolean' ? observedBeforeGesture : null;
  const grantProvenance = !granted ? 'not_granted' : observation === true ? 'preexisting_observed' : 'unknown';
  return {
    permission: request.permissions[0],
    granted,
    observedBeforeGesture: observation,
    grantProvenance
  };
}

/**
 * Rolls back only a grant proven new to this UI attempt, and only after a
 * refreshed authoritative settings snapshot proves the feature is disabled.
 * Unknown authoritative state preserves the permission for later recovery.
 */
export async function reconcileNewOptionalPermissionGrant(
  {
    permission,
    granted = false,
    grantProvenance = 'unknown',
    authoritativeStateKnown = false,
    authoritativeFeatureEnabled = false
  } = {},
  permissionsApi = chrome.permissions
) {
  const name = String(permission || '').trim();
  if (!granted) return { attempted: false, released: false, preserved: false, reason: 'no_grant' };
  if (grantProvenance === 'preexisting_observed') {
    return { attempted: false, released: false, preserved: true, reason: 'preexisting_observed' };
  }
  if (authoritativeFeatureEnabled) {
    return { attempted: false, released: false, preserved: true, reason: 'authoritative_feature_enabled' };
  }
  if (!authoritativeStateKnown) {
    return { attempted: false, released: false, preserved: true, reason: 'authoritative_state_unknown' };
  }
  // Chrome does not report whether request() displayed a prompt or merely
  // confirmed an existing grant. Never revoke an ambiguous user-controlled
  // permission after a rejected settings save.
  if (grantProvenance !== 'newly_granted') {
    return { attempted: false, released: false, preserved: true, reason: 'grant_provenance_unknown' };
  }

  try {
    assertPermissionApi(permissionsApi, ['contains', 'remove']);
    const request = buildNamedPermissionRequest(name);
    const grantedBefore = Boolean(await permissionsApi.contains(request));
    if (!grantedBefore) {
      return {
        attempted: false,
        released: true,
        preserved: false,
        reason: 'already_absent'
      };
    }
    const removeResult = Boolean(await permissionsApi.remove(request));
    const accessRemains = Boolean(await permissionsApi.contains(request));
    return {
      attempted: true,
      removeResult,
      released: !accessRemains,
      preserved: accessRemains,
      reason: accessRemains ? 'release_not_confirmed' : 'absence_proved'
    };
  } catch (error) {
    return {
      attempted: true,
      released: false,
      preserved: true,
      reason: 'release_uncertain',
      error: error?.message || String(error)
    };
  }
}
