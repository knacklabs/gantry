import type { PermissionLane } from '../../domain/permission-lane.js';
import type { PermissionMode } from '../../shared/permission-mode.js';

export interface AutoLaneAnalysisInput {
  permissionMode: PermissionMode;
  hostJobId?: string;
  command?: string;
}

export interface AutoLaneAnalysis {
  readonly lane: PermissionLane;
  readonly readOnlyMetaExecutor: boolean;
}

const PROTECTED_FILE_NAMES = new Set([
  '.mcp.json',
  'mcp.json',
  'skill.md',
  'settings.json',
  'settings.local.json',
  'settings.yaml',
  'settings.yml',
]);
const SECRET_FILE_NAME =
  /^(?:authorized_keys|credentials?(?:\..+)?|g?shadow|id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?|known_hosts|passwords?(?:\..+)?|secrets?(?:\..+)?|tokens?(?:\..+)?|.+\.(?:key|p12|pem|pfx))$/i;

/** Pure string-only superset of filesystem-backed protected-path checks. */
export function isSensitivePathShape(value: string): boolean {
  const segments = value
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean);
  if (segments.some((segment) => segment !== '.' && segment.startsWith('.'))) {
    return true;
  }
  const normalizedSegments = segments.map((segment) => segment.toLowerCase());
  if (
    normalizedSegments.some(
      (segment) =>
        PROTECTED_FILE_NAMES.has(segment) || SECRET_FILE_NAME.test(segment),
    )
  ) {
    return true;
  }
  const normalizedPath = normalizedSegments.join('/');
  // TODO(T2a): share these pure shapes with the canonical protected-path gate.
  return (
    normalizedPath.includes('.codex/skills') ||
    normalizedPath.includes('.agents/skills') ||
    normalizedPath.includes('.claude/skills') ||
    normalizedPath.includes('artifacts/skills') ||
    /(?:^|\/)agents\/[^/]+\/skills(?:\/|$)/.test(normalizedPath)
  );
}
