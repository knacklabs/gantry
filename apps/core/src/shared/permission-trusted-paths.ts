import path from 'node:path';

import {
  bashExecutableName,
  type BashCommandLeaf,
} from './bash-command-parser.js';

export function outOfTrustedRootReason(
  leaves: readonly BashCommandLeaf[],
  workspaceRoot: string | undefined,
  trustedRoots: readonly string[],
): string | undefined {
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
    return 'Command working directory is unavailable or non-canonical.';
  }
  if (trustedRoots.length === 0) {
    return 'Command is outside the owner-declared trusted roots.';
  }
  for (const leaf of leaves) {
    const cwd = leafCwd(leaf, workspaceRoot);
    if (!isTrustedPath(cwd, trustedRoots)) {
      return `Command working directory is outside the owner-declared trusted roots: ${cwd}.`;
    }
    for (const candidate of pathCandidates(leaf)) {
      if (
        candidate.startsWith('~/') ||
        !isTrustedPath(path.resolve(cwd, candidate), trustedRoots)
      ) {
        return `Command target is outside the owner-declared trusted roots: ${candidate}.`;
      }
    }
  }
  return undefined;
}

function leafCwd(leaf: BashCommandLeaf, workspaceRoot: string): string {
  let cwd = path.resolve(workspaceRoot);
  if (bashExecutableName(leaf.argv[0] ?? '') !== 'git') return cwd;
  for (let index = 1; index < leaf.argv.length; index += 1) {
    if (leaf.argv[index] !== '-C') continue;
    if (leaf.argv[index + 1]) cwd = path.resolve(cwd, leaf.argv[index + 1]);
    index += 1;
  }
  return cwd;
}

function pathCandidates(leaf: BashCommandLeaf): string[] {
  return [
    ...leaf.redirects.map(({ target }) => target),
    ...leaf.argv.slice(1).flatMap((arg) => {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
      return path.isAbsolute(value) || /^(?:\.{1,2}|~)(?:\/|$)/.test(value)
        ? [value]
        : [];
    }),
  ];
}

function isTrustedPath(
  candidate: string,
  trustedRoots: readonly string[],
): boolean {
  return trustedRoots.some((root) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return (
      relative === '' ||
      (!path.isAbsolute(relative) &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`))
    );
  });
}
