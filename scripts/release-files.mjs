export const RUNTIME_FILES = Object.freeze(
  [
    'assets/icons/icon16.png',
    'assets/icons/icon32.png',
    'assets/icons/icon48.png',
    'assets/icons/icon128.png',
    'background/cleanup-authorization.js',
    'background/cleanup-preflight.js',
    'background/cleanup.js',
    'background/cookies.js',
    'background/dnr-shield.js',
    'background/domain.js',
    'background/downloads.js',
    'background/history.js',
    'background/operation-control.js',
    'background/origin-storage.js',
    'background/page-scrub.js',
    'background/permission-leases.js',
    'background/progress-overlay.js',
    'background/record-discovery.js',
    'background/report.js',
    'background/service-worker.js',
    'background/shield-recovery.js',
    'background/scope-discovery.js',
    'background/tab-state.js',
    'background/verification.js',
    'manifest.json',
    'options/options.css',
    'options/options.html',
    'options/options.js',
    'options/permission-lifecycle.js',
    'popup/popup.css',
    'popup/popup.html',
    'popup/popup.js',
    'shared/cleanup-mode.js',
    'shared/cleanup-review.js',
    'shared/components.css',
    'shared/constants.js',
    'shared/host-permissions.js',
    'shared/message-contracts.js',
    'shared/messaging.js',
    'shared/public-suffix-data.js',
    'shared/public-suffix.js',
    'shared/report-integrity.js',
    'shared/report-redaction.js',
    'shared/side-panel-report-binding.js',
    'shared/safety.js',
    'shared/settings-backup.js',
    'shared/state-schema.js',
    'shared/storage.js',
    'shared/target-scope.js',
    'shared/theme.css',
    'shared/verification-evidence.js',
    'sidepanel/sidepanel.css',
    'sidepanel/sidepanel.html',
    'sidepanel/report-outcome.js',
    'sidepanel/sidepanel.js'
  ].sort()
);

export const SOURCE_ONLY_FILES = Object.freeze(
  ['package.json', 'README.md', 'test-harness/release-selftest.mjs'].sort()
);

export const SOURCE_ARCHIVE_ROOT_FILES = Object.freeze(
  [
    '.editorconfig',
    '.gitattributes',
    '.gitignore',
    '.htmlvalidate.json',
    '.prettierignore',
    '.prettierrc.json',
    '.stylelintrc.json',
    'CHANGELOG.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'PRIVACY.md',
    'README.md',
    'SECURITY.md',
    'SUPPORT.md',
    'THIRD_PARTY_NOTICES.md',
    'eslint.config.js',
    'jsconfig.json',
    'package-lock.json',
    'package.json'
  ].sort()
);

export const SOURCE_ARCHIVE_DIRECTORIES = Object.freeze(
  ['.github', 'assets', 'docs', 'scripts', 'src', 'tests', 'third_party'].sort()
);

export const FORBIDDEN_PACKAGE_PATTERNS = Object.freeze([
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)coverage(\/|$)/i,
  /(^|\/)test-results(\/|$)/i,
  /(^|\/)playwright-report(\/|$)/i,
  /(^|\/)browser-profiles?(\/|$)/i,
  /(^|\/)\.pnpm-store(\/|$)/i,
  /(^|\/)sitewipe_versions(\/|$)/i,
  /(^|\/)_work(\/|$)/i,
  /\.(?:docx?|zip|log|pem|key|pfx|p12)$/i,
  /(?:prompt|transcript|chat[-_ ]?log)/i
]);
