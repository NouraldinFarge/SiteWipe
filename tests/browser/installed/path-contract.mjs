import { posix, win32 } from 'node:path';

export function isPortableLocalAbsolutePath(value) {
  return isLocalPathString(value) && (isLocalPosixAbsolutePath(value) || isDriveQualifiedWindowsAbsolutePath(value));
}

export function isDriveQualifiedWindowsAbsolutePath(value) {
  return isLocalPathString(value) && /^[A-Za-z]:[\\/]/u.test(value) && win32.isAbsolute(value);
}

export function isNativeLocalAbsolutePath(value) {
  return process.platform === 'win32'
    ? isDriveQualifiedWindowsAbsolutePath(value)
    : isLocalPathString(value) && isLocalPosixAbsolutePath(value);
}

export function assertNativeAbsolutePath(value, label) {
  if (!isNativeLocalAbsolutePath(value)) {
    throw new Error(`${label} must be an absolute path on the current host.`);
  }
  return value;
}

function isLocalPosixAbsolutePath(value) {
  return /^\/(?!\/)/u.test(value) && posix.isAbsolute(value);
}

function isLocalPathString(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !value.includes('\0');
}
