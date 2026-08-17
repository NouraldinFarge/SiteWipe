import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { RUNTIME_FILES } from './release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src');
const failures = [];
const linter = new Linter({ configType: 'flat' });
const noRuntimeRemoteCodeRule = createNoRuntimeRemoteCodeRule();

for (const relative of RUNTIME_FILES) {
  const extension = extname(relative).toLowerCase();
  if (!['.js', '.html', '.css', '.json'].includes(extension)) continue;
  const text = await readFile(resolve(src, relative), 'utf8');
  if (extension === '.js' && relative !== 'shared/public-suffix-data.js') {
    const messages = linter.verify(
      text,
      {
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        plugins: {
          sitewipe: {
            rules: { 'no-runtime-remote-code': noRuntimeRemoteCodeRule }
          }
        },
        rules: { 'sitewipe/no-runtime-remote-code': 'error' }
      },
      { filename: relative }
    );
    for (const message of messages) {
      failures.push(`${relative}:${message.line || 0}:${message.column || 0}: ${message.message}`);
    }
  }
  if (extension === '.html') {
    if (/\son[a-z]+\s*=/i.test(text)) failures.push(`${relative}: inline event handler`);
    for (const match of text.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gi)) {
      if (/^(?:https?:)?\/\//i.test(match[1])) failures.push(`${relative}: remote page resource ${match[1]}`);
    }
    if (/<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(text))
      failures.push(`${relative}: inline script`);
  }
  if (extension === '.css' && /url\(\s*['"]?(?:https?:)?\/\//i.test(text))
    failures.push(`${relative}: remote CSS resource`);
  if (/\b(?:AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)\b/.test(text))
    failures.push(`${relative}: possible secret/private key`);
  if (/[A-Za-z]:\\(?:Users|Documents|Extensions_Programs)\\/i.test(text))
    failures.push(`${relative}: absolute local path`);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`Remote-code and secret scan passed for ${RUNTIME_FILES.length} allowlisted runtime files.`);

function createNoRuntimeRemoteCodeRule() {
  return {
    meta: { type: 'problem', schema: [], messages: { forbidden: 'Forbidden runtime code capability: {{name}}.' } },
    create(context) {
      const forbiddenIdentifiers = new Set([
        'eval',
        'Function',
        'importScripts',
        'XMLHttpRequest',
        'EventSource',
        'WebSocket',
        'fetch',
        'WebAssembly'
      ]);
      const report = (node, name) => context.report({ node, messageId: 'forbidden', data: { name } });
      const checkModuleSource = (node) => {
        const source = node?.source?.value;
        if (typeof source === 'string' && /^(?:https?:)?\/\//i.test(source)) report(node, 'remote module import');
      };
      return {
        Identifier(node) {
          if (forbiddenIdentifiers.has(node.name)) report(node, node.name);
        },
        ImportDeclaration: checkModuleSource,
        ExportNamedDeclaration: checkModuleSource,
        ExportAllDeclaration: checkModuleSource,
        ImportExpression(node) {
          report(node, 'dynamic import()');
        },
        CallExpression(node) {
          const calleeName = node.callee?.type === 'Identifier' ? node.callee.name : '';
          if (
            ['setTimeout', 'setInterval'].includes(calleeName) &&
            node.arguments?.[0]?.type === 'Literal' &&
            typeof node.arguments[0].value === 'string'
          ) {
            report(node, `${calleeName} string evaluation`);
          }
          if (
            node.callee?.type === 'MemberExpression' &&
            node.callee.property?.type === 'Identifier' &&
            node.callee.property.name === 'createElement' &&
            node.arguments?.[0]?.type === 'Literal' &&
            String(node.arguments[0].value).toLowerCase() === 'script'
          ) {
            report(node, 'dynamic script element creation');
          }
        }
      };
    }
  };
}
