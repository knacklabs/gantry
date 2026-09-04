import fs from 'fs';
import path from 'path';

import {
  capabilityTokens,
  hasHiddenPathSegment,
} from './auto-permission-read-only-catalog.js';
import { allProtectedPathMentions } from './tool-execution-protected-paths.js';

const FILE_CAPABILITY_DOMAINS = new Set([
  'file',
  'files',
  'filesystem',
  'repo',
  'workspace',
]);
const SECRET_PATH =
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|environ(?:ment)?|id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?|[^/\\]*(?:api[_-]?key|credential|private[_-]?key|secret|token)[^/\\]*|(?:[^/\\]*[_.-])?key(?:s)?(?:[_.-][^/\\]*)?|[^/\\]+\.(?:key|pem|p12|pfx))(?:$|[/\\])/i;

export interface PermissionHardBoundaryResult {
  allowed: boolean;
  reason: string;
}

export function evaluateReadHardBoundaries(input: {
  action: 'list' | 'read';
  targets: readonly string[];
  requiresTarget: boolean;
  capabilityIds: readonly string[];
  workspaceRoot?: string;
}): PermissionHardBoundaryResult {
  const { action, targets, capabilityIds, workspaceRoot } = input;
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    return blocked(`The file ${action} requires an absolute workspace root.`);
  }
  let resolvedWorkspaceRoot: string;
  try {
    resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    return blocked(`The file ${action} workspace root could not be resolved.`);
  }
  // This pre-execution check is sound because the runner cannot create symlinks
  // without a separately-approved write: Write/Edit create regular files, and
  // `ln -s` via Bash is not in the silent set.
  for (const target of targets.length > 0 ? targets : ['.']) {
    let resolvedTarget: string;
    try {
      resolvedTarget = fs.realpathSync.native(
        path.resolve(resolvedWorkspaceRoot, target),
      );
    } catch {
      return blocked(`The file ${action} target could not be resolved.`);
    }
    if (!isWithinPath(resolvedWorkspaceRoot, resolvedTarget)) {
      return blocked(`The resolved file ${action} target is not safe.`);
    }
    // Hidden/secret checks apply to the workspace-relative part only: the
    // root itself is host-provisioned (GANTRY_HOME may legitimately be a
    // dotted path), while everything below it is agent-influenced.
    const relativeTarget = path.relative(resolvedWorkspaceRoot, resolvedTarget);
    if (
      hasHiddenPathSegment(relativeTarget) ||
      allProtectedPathMentions(resolvedTarget).length > 0 ||
      isSecretLikeValue(relativeTarget)
    ) {
      return blocked(`The resolved file ${action} target is not safe.`);
    }
  }
  const boundary = capabilityIds.find((id) => {
    const tokens = capabilityTokens(id);
    return (
      tokens.length === 2 &&
      FILE_CAPABILITY_DOMAINS.has(tokens[0] ?? '') &&
      (tokens.at(-1) === action || tokens.at(-1) === 'read')
    );
  });
  if (!boundary) {
    return blocked(`No approved file ${action} capability boundary matches.`);
  }
  return allowed(`Parser-proven file ${action} within ${boundary}.`);
}

export function isSecretLikeValue(value: string): boolean {
  return SECRET_PATH.test(value);
}

function isWithinPath(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function allowed(reason: string): PermissionHardBoundaryResult {
  return { allowed: true, reason };
}

function blocked(reason: string): PermissionHardBoundaryResult {
  return { allowed: false, reason };
}
