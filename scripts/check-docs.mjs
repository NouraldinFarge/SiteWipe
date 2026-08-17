import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const markdown = [...(await filesBelow(root, (path) => path.endsWith('.md')))].filter((path) => !ignored(path));
const failures = [];
const exactStatus =
  'Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.';
const statusRequired = new Set([
  'README.md',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'docs/architecture.md',
  'docs/threat-model.md',
  'docs/safety-case.md',
  'docs/permissions.md',
  'docs/privacy-data-flow.md',
  'docs/testing.md',
  'docs/performance.md',
  'docs/releasing.md',
  'docs/capability-matrix.md',
  'docs/claim-evidence.md',
  'docs/release-readiness.md',
  'docs/provenance.md'
]);

for (const path of markdown) {
  const repoPath = relative(root, path).replaceAll('\\', '/');
  const text = await readFile(path, 'utf8');
  if (statusRequired.has(repoPath) && !text.includes(exactStatus))
    failures.push(`${repoPath}: exact release status missing`);
  for (const match of text.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    target = decodeURIComponent(target.split('#')[0]);
    if (!target) continue;
    try {
      await lstat(resolve(dirname(path), target));
    } catch {
      failures.push(`${repoPath}: missing local link ${match[1]}`);
    }
  }
}

await verifyRemoteDocumentationState();

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`Documentation check passed for ${markdown.length} Markdown files.`);

async function filesBelow(directory, predicate) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (ignored(path)) continue;
    if (entry.isDirectory()) output.push(...(await filesBelow(path, predicate)));
    else if (entry.isFile() && predicate(path)) output.push(path);
  }
  return output;
}

function ignored(path) {
  return /[\\/](?:node_modules|coverage|dist|\.git)(?:[\\/]|$)/i.test(path);
}

async function verifyRemoteDocumentationState() {
  let remote;
  try {
    remote = JSON.parse(await readFile(resolve(root, 'docs/decisions/remote-publication.json'), 'utf8'));
  } catch (error) {
    failures.push(`docs/decisions/remote-publication.json: unreadable decision record (${error.message})`);
    return;
  }

  const [security, codeowners, issues] = await Promise.all([
    readFile(resolve(root, 'SECURITY.md'), 'utf8'),
    readFile(resolve(root, '.github/CODEOWNERS'), 'utf8'),
    readFile(resolve(root, 'docs/issue-register.md'), 'utf8')
  ]);
  const maintainer = String(remote?.maintainerHandle || '').trim();
  const repositoryUrl = String(remote?.repositoryUrl || '').trim();

  if (remote?.ownerApproved === true && maintainer) {
    const ownerLines = new Set(codeowners.split(/\r?\n/).map((line) => line.trim()));
    if (!ownerLines.has(`* @${maintainer}`))
      failures.push(`.github/CODEOWNERS: missing owner-approved maintainer @${maintainer}`);
  }

  if (remote?.repositoryCreated === true) {
    if (!repositoryUrl || !security.includes(repositoryUrl))
      failures.push('SECURITY.md: created repository URL is missing');
    if (/repository remote[^\n]*not yet been created/i.test(security))
      failures.push('SECURITY.md: contradicts the recorded repository creation');
  }

  if (remote?.initialPushVerified === true && /Repository has no commits, remote/i.test(issues))
    failures.push('docs/issue-register.md: contradicts the verified initial push');

  const reportsUnavailable = security.includes('GitHub Private Vulnerability Reporting is not enabled');
  if (remote?.privateVulnerabilityReportingVerified === true && reportsUnavailable)
    failures.push('SECURITY.md: says private reporting is unavailable after verification');
  if (remote?.privateVulnerabilityReportingVerified !== true && !reportsUnavailable)
    failures.push('SECURITY.md: must disclose that private reporting is not enabled');
}
