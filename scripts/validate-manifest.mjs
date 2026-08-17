import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src');
const manifest = JSON.parse(await readFile(resolve(src, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const errors = [];

requireValue(manifest.manifest_version === 3, 'manifest_version must be 3');
requireValue(/^\d+\.\d+\.\d+$/.test(manifest.version || ''), 'manifest version must be numeric x.y.z');
requireValue(manifest.version === pkg.version, 'manifest and package versions must match');
requireValue(
  typeof manifest.description === 'string' && manifest.description.length <= 132,
  'description must be 132 characters or fewer'
);
requireValue(Number(manifest.minimum_chrome_version) >= 119, 'minimum_chrome_version must cover partitionKey support');
requireValue(manifest.incognito === 'spanning', 'incognito mode must remain explicit');
requireValue(!manifest.host_permissions, 'required host_permissions are prohibited');
requireValue(
  equalSet(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']),
  'optional host declarations must be web schemes only'
);
requireValue(
  equalSet(manifest.optional_permissions, ['webNavigation']),
  'only webNavigation may be an optional named permission'
);
requireValue(
  equalSet(manifest.permissions, [
    'alarms',
    'browsingData',
    'cookies',
    'declarativeNetRequest',
    'downloads',
    'history',
    'scripting',
    'sidePanel',
    'storage',
    'tabs'
  ]),
  'required permissions changed without updating the reviewed permission contract'
);
for (const forbidden of [
  'key',
  'update_url',
  'externally_connectable',
  'content_scripts',
  'web_accessible_resources'
]) {
  requireValue(!(forbidden in manifest), `${forbidden} is prohibited in this package`);
}
const csp = manifest.content_security_policy?.extension_pages || '';
requireValue(/script-src\s+'self'/.test(csp), 'CSP must restrict scripts to self');
requireValue(/object-src\s+'none'/.test(csp), 'CSP must prohibit objects');
requireValue(!/unsafe-eval|unsafe-inline|https?:/i.test(csp), 'CSP must not allow unsafe or remote code');

const resources = [
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_page,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {})
].filter(Boolean);
for (const resource of resources) {
  requireValue(isSafeRelative(resource), `unsafe manifest resource path: ${resource}`);
  try {
    const info = await stat(resolve(src, resource));
    requireValue(info.isFile() && info.size > 0, `manifest resource is not a non-empty file: ${resource}`);
  } catch {
    errors.push(`manifest resource is missing: ${resource}`);
  }
}

for (const [size, relative] of Object.entries(manifest.icons || {})) {
  try {
    const bytes = await readFile(resolve(src, relative));
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    requireValue(
      width === Number(size) && height === Number(size),
      `${relative} must be ${size}x${size}, found ${width}x${height}`
    );
  } catch (error) {
    errors.push(`could not validate icon ${relative}: ${error.message}`);
  }
}

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}
console.log(
  `Manifest validation passed: v${manifest.version}, ${manifest.description.length}/132 description characters, ${manifest.permissions.length} required permissions.`
);

function requireValue(value, message) {
  if (!value) errors.push(message);
}

function equalSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

function isSafeRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.split('/').includes('..')
  );
}
