const SIDE_PANEL_REPORT_BINDING_PREFIX = 'sitewipe.sidePanelReportBinding.v1';
const SIDE_PANEL_REPORT_BINDING_TTL_MS = 5 * 60 * 1000;

export function getSidePanelReportBindingStorageKey(windowId) {
  if (!Number.isInteger(windowId) || windowId < 0) {
    throw new Error('A valid browser window is required to bind the full report.');
  }
  return `${SIDE_PANEL_REPORT_BINDING_PREFIX}.${windowId}`;
}

export function createSidePanelReportBinding(reportId, windowId, now = Date.now()) {
  const normalizedReportId = normalizeReportId(reportId);
  if (!normalizedReportId) throw new Error('A valid stored report is required to bind the side panel.');
  if (!Number.isInteger(windowId) || windowId < 0) {
    throw new Error('A valid browser window is required to bind the full report.');
  }
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('The report binding time is invalid.');
  return Object.freeze({
    schemaVersion: 1,
    reportId: normalizedReportId,
    windowId,
    createdAt: new Date(timestamp).toISOString(),
    expiresAt: new Date(timestamp + SIDE_PANEL_REPORT_BINDING_TTL_MS).toISOString()
  });
}

export function normalizeSidePanelReportBinding(value, expectedWindowId, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return null;
  const reportId = normalizeReportId(value.reportId);
  const windowId = Number.isInteger(value.windowId) && value.windowId >= 0 ? value.windowId : null;
  const createdAt = typeof value.createdAt === 'string' ? Date.parse(value.createdAt) : Number.NaN;
  const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : Number.NaN;
  const timestamp = Number(now);
  if (
    !reportId ||
    windowId === null ||
    windowId !== expectedWindowId ||
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(timestamp) ||
    expiresAt <= createdAt ||
    expiresAt - createdAt !== SIDE_PANEL_REPORT_BINDING_TTL_MS ||
    timestamp < createdAt ||
    timestamp >= expiresAt
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    reportId,
    windowId,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  });
}

function normalizeReportId(value) {
  return typeof value === 'string' && value.trim() && value.length <= 256 ? value : null;
}
