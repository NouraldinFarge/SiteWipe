function buildNamedPermissionRequest(permission) {
  const name = String(permission || '').trim();
  if (!name) throw new Error('Optional permission name is unavailable.');
  return { permissions: [name] };
}

function assertPermissionApi(permissionsApi, methods) {
  for (const method of methods) {
    if (typeof permissionsApi?.[method] !== 'function') {
      throw new Error(`Optional permission ${method} API is unavailable.`);
    }
  }
}

/** Observes optional named-permission state outside a user gesture. */
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
 * call in its dedicated click path. Awaiting contains() here can consume the
 * user activation before the native prompt opens. The result deliberately says
 * nothing about which extension context or browser action created the grant.
 */
export async function requestOptionalPermission(permission, permissionsApi = chrome.permissions) {
  assertPermissionApi(permissionsApi, ['request']);
  const request = buildNamedPermissionRequest(permission);
  const granted = (await permissionsApi.request(request)) === true;
  return {
    permission: request.permissions[0],
    granted
  };
}

/**
 * Removes optional access only from a dedicated, explicit user action. This
 * does not inspect or infer ownership before removal.
 */
export async function removeOptionalPermission(permission, permissionsApi = chrome.permissions) {
  assertPermissionApi(permissionsApi, ['remove']);
  const request = buildNamedPermissionRequest(permission);
  const removed = (await permissionsApi.remove(request)) === true;
  return {
    permission: request.permissions[0],
    removed
  };
}
