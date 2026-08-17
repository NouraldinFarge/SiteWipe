export async function buildReportIntegrity(report) {
  const copy = JSON.parse(JSON.stringify(report || {}));
  delete copy.integrity;
  const digest = await sha256(stableStringify(copy));
  return {
    algorithm: 'sha256',
    digest: `sha256-${digest}`,
    note: 'Local SHA-256 content checksum for detecting report-content mismatch. It is not a signature and does not authenticate the report or its author.'
  };
}

export async function refreshReportIntegrity(report) {
  report.integrity = await buildReportIntegrity(report);
  return report.integrity;
}

export async function getReportIntegrityDigest(report) {
  return (await buildReportIntegrity(report)).digest;
}

export async function verifyReportIntegrity(report) {
  const expected = report?.integrity?.digest || '';
  return Boolean(expected && expected === (await getReportIntegrityDigest(report)));
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256(text) {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable in this browser context.');
  const bytes = new TextEncoder().encode(String(text || ''));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
