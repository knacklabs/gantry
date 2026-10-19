import { permissionPromptSafe } from '../shared/permission-display-input.js';

export function permissionPromptTitle(
  sourceAgentFolder: string,
  label: string,
): string {
  return `Allow ${formatPermissionAgentDisplayName(sourceAgentFolder)} to use ${label}?`;
}

export function formatPermissionAgentDisplayName(
  sourceAgentFolder: string,
): string {
  const sanitized = sanitizeAgentName(sourceAgentFolder);
  if (!sanitized) return 'this agent';
  const withoutPrefix = sanitized.replace(/^agent:/i, '');
  const words = withoutPrefix
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!words) return 'this agent';
  return words
    .split(' ')
    .map((word) =>
      /^[A-Z0-9]+$/.test(word)
        ? word
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join(' ');
}

function sanitizeAgentName(input: string): string {
  return permissionPromptSafe(input, { head: 120, tail: 40 }).trim();
}
