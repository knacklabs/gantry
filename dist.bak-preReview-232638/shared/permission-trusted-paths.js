import fs from 'node:fs';
import path from 'node:path';
import { bashExecutableName, } from './bash-command-parser.js';
export function outOfTrustedRootReason(leaves, workspaceRoot, trustedRoots) {
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
            if (candidate.startsWith('~/') ||
                !isTrustedPath(path.resolve(cwd, candidate), trustedRoots)) {
                return `Command target is outside the owner-declared trusted roots: ${candidate}.`;
            }
        }
    }
    return undefined;
}
// Canonical (symlink-resolved) form of a learned trusted root, so the stored
// root and the containment checks share PERM-1's realpath semantics.
export function canonicalizeTrustedRoot(target) {
    return realResolve(target);
}
function leafCwd(leaf, workspaceRoot) {
    let cwd = path.resolve(workspaceRoot);
    if (bashExecutableName(leaf.argv[0] ?? '') !== 'git')
        return cwd;
    for (let index = 1; index < leaf.argv.length; index += 1) {
        if (leaf.argv[index] !== '-C')
            continue;
        if (leaf.argv[index + 1])
            cwd = path.resolve(cwd, leaf.argv[index + 1]);
        index += 1;
    }
    return cwd;
}
// Check every option value and every positional token, rather than guessing
// which tokens are paths — a guess is what let `escape/.git` and slashless
// `--git-dir=escape` slip past containment. Tokens that resolve inside cwd
// (subcommands, branch names, remote URLs, message text) pass harmlessly; only
// a token that canonicalizes outside the trusted root asks. Bare flags (`-C`,
// `-m`) carry no path and are skipped; their values arrive as later tokens.
function pathCandidates(leaf) {
    return [
        ...leaf.redirects.map(({ target }) => target),
        ...leaf.argv.slice(1).flatMap((arg) => {
            if (arg.startsWith('-')) {
                const eq = arg.indexOf('=');
                return eq >= 0 ? [arg.slice(eq + 1)] : [];
            }
            return [arg];
        }),
    ];
}
function isTrustedPath(candidate, trustedRoots) {
    const realCandidate = realResolve(candidate);
    return trustedRoots.some((root) => {
        const relative = path.relative(realResolve(root), realCandidate);
        return (relative === '' ||
            (!path.isAbsolute(relative) &&
                relative !== '..' &&
                !relative.startsWith(`..${path.sep}`)));
    });
}
// Canonicalize symlinks so a path lexically inside a trusted root cannot target
// outside it via a symlink. realpathSync throws on paths that do not exist yet
// (e.g. a clone target dir), so resolve the longest existing ancestor and
// re-append the not-yet-created tail.
function realResolve(target) {
    let current = path.resolve(target);
    const tail = [];
    for (;;) {
        try {
            const real = fs.realpathSync(current);
            return tail.length ? path.join(real, ...tail.reverse()) : real;
        }
        catch {
            const parent = path.dirname(current);
            if (parent === current)
                return path.resolve(target);
            tail.push(path.basename(current));
            current = parent;
        }
    }
}
