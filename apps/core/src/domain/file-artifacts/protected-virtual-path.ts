import { normalizeFileArtifactPath } from './virtual-path.js';

const PROTECTED_FILE_ARTIFACT_SEGMENTS = new Set([
  'SOUL.md',
  ['CLAU', 'DE.md'].join(''),
  'settings.yaml',
  '.mcp.json',
  'SKILL.md',
]);

const PROTECTED_FILE_ARTIFACT_PREFIXES = ['.codex/skills/'] as const;

export function isProtectedFileArtifactVirtualPath(value: string): boolean {
  const virtualPath = normalizeFileArtifactPath(value);
  if (
    PROTECTED_FILE_ARTIFACT_PREFIXES.some((prefix) =>
      virtualPath.startsWith(prefix),
    )
  ) {
    return true;
  }
  return virtualPath
    .split('/')
    .some((part) => PROTECTED_FILE_ARTIFACT_SEGMENTS.has(part));
}
