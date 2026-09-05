import fs from 'node:fs/promises';
import path from 'node:path';

import { hasHiddenPathSegment } from './auto-permission-read-only-catalog.js';
import { isSecretLikeValue } from './permission-hard-boundaries.js';
import { isProtectedCapabilityPathLike } from './tool-execution-protected-paths.js';

export interface ProspectiveWriteBoundaryResult {
  inside: boolean;
  reason?: string;
}

export async function evaluateProspectiveWriteBoundary(input: {
  workspaceRoot?: string;
  candidatePath: string;
}): Promise<ProspectiveWriteBoundaryResult> {
  if (!input.workspaceRoot) return outside('workspace root is required');
  if (!path.isAbsolute(input.workspaceRoot)) {
    return outside('workspace root must be absolute');
  }
  try {
    const root = await fs.realpath(input.workspaceRoot);
    const candidate = path.resolve(root, input.candidatePath);
    if (!isWithinPath(root, candidate)) {
      return outside('write target escapes workspace');
    }
    const relative = path.relative(root, candidate);
    if (isProtectedCapabilityPathLike(relative)) {
      return outside('write target is protected');
    }
    if (hasHiddenPathSegment(relative)) {
      return outside('write target contains a hidden path');
    }
    if (isSecretLikeValue(relative)) {
      return outside('write target looks secret');
    }

    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) {
          return outside('write target crosses a symlink');
        }
      } catch (error) {
        if (isMissingPathError(error)) break;
        return outside('write boundary could not be verified');
      }
    }
    const existingAncestor = await nearestExistingAncestor(current, root);
    const realAncestor = await fs.realpath(existingAncestor);
    return isWithinPath(root, realAncestor)
      ? { inside: true }
      : outside('write target escapes workspace');
  } catch {
    return outside('workspace root could not be resolved');
  }
}

async function nearestExistingAncestor(
  candidate: string,
  root: string,
): Promise<string> {
  let current = candidate;
  while (current !== root) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      current = path.dirname(current);
    }
  }
  return root;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
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

function outside(reason: string): ProspectiveWriteBoundaryResult {
  return { inside: false, reason };
}
