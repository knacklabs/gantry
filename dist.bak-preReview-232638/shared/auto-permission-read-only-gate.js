import fs from 'fs';
import path from 'path';
import { bashExecutableName, parseBashCommand, } from './bash-command-parser.js';
import { BARE_SAFE_EXECUTABLES, capabilityTokens, GENERIC_READ_EXECUTABLES, genericReadFileArgs, hasHiddenPathSegment, normalizeCapabilityId, sedReadFileArgs, } from './auto-permission-read-only-catalog.js';
import { mcpToolPatternCovers } from './mcp-tool-scope.js';
import { allProtectedPathMentions } from './tool-execution-protected-paths.js';
const FILE_CAPABILITY_DOMAINS = new Set([
    'file',
    'files',
    'filesystem',
    'repo',
    'workspace',
]);
const CAT_OPTIONS = new Set([
    '-A',
    '-E',
    '-T',
    '-b',
    '-n',
    '-s',
    '-v',
    '--number',
    '--number-nonblank',
    '--show-all',
    '--show-ends',
    '--show-nonprinting',
    '--show-tabs',
    '--squeeze-blank',
]);
// -H/-L remain excluded because they follow symlinks beyond the checked target.
const LS_OPTIONS = /^-(?:[1ACFRSTUabcdfghiklmnopqrstux@])+$/;
const LS_LONG_OPTIONS = /^--(?:all|almost-all|classify|directory|file-type|group-directories-first|human-readable|inode|long|numeric-uid-gid|recursive|reverse|size|color(?:=\w+)?|sort=\w+|time=\w+)$/;
// `;`, `&`, `|` are intentionally absent: they gate the safe-compound path
// (`&&`/`||`/`;`/`|`), which parseBashCommand splits into leaves we vet
// individually. Redirects (`<`/`>`), command substitution (`` ` ``/`$(...)`),
// braces, globs (`*`/`?`/`[]`), and comments (`#`) still block outright.
const SHELL_CONTROL_OR_EXPANSION = /[\r\n#<>`$(){}*?\[\]]/;
const SECRET_KEY = /(?:^|[_-])(?:apikey|authorization|credential|key|password|private[_-]?key|secret|token)(?:$|[_-])/i;
const SECRET_PATH = /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|environ(?:ment)?|id_(?:dsa|ecdsa|ed25519|rsa)(?:\.pub)?|[^/\\]*(?:api[_-]?key|credential|private[_-]?key|secret|token)[^/\\]*|(?:[^/\\]*[_.-])?key(?:s)?(?:[_.-][^/\\]*)?|[^/\\]+\.(?:key|pem|p12|pfx))(?:$|[/\\])/i;
const SECRET_VALUE = /-----BEGIN [^-]*PRIVATE KEY-----|(?:^|\s)Bearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/i;
export function evaluateAutoPermissionReadOnlyGate(input) {
    const capabilityIds = input.approvedCapabilityIds
        .map(normalizeCapabilityId)
        .filter(Boolean);
    if (capabilityIds.length === 0) {
        return blocked('No approved capability boundary covers this action.');
    }
    if (input.canonicalToolName === 'Bash' ||
        input.canonicalToolName === 'RunCommand') {
        return evaluateShellRead(input.toolInput, capabilityIds, input.workspaceRoot);
    }
    return evaluateMcpRead(input.canonicalToolName, input.toolInput, capabilityIds, input.reviewedMcpReadBindings);
}
function evaluateShellRead(toolInput, capabilityIds, workspaceRoot) {
    const command = commandText(toolInput);
    if (!command)
        return blocked('Shell command is missing.');
    if (SHELL_CONTROL_OR_EXPANSION.test(command)) {
        return blocked('Shell controls, expansions, redirects, and globs require approval.');
    }
    if (allProtectedPathMentions(command).length > 0) {
        return blocked('Protected paths require approval.');
    }
    const parsed = parseGateCommand(command);
    if (!parsed.ok) {
        return blocked(`Shell command is not provably simple: ${parsed.reason}`);
    }
    const compound = parsed.leaves.length > 1;
    if (!compound) {
        return evaluateLeaf(parsed.leaves[0], capabilityIds, workspaceRoot, false);
    }
    // A compound (`&&`/`||`/`;`/`|`) is allowed only when EVERY leaf is a proven
    // safe read; a leaf feeding a pipe legitimately reads stdin, so targets are
    // optional there.
    for (const leaf of parsed.leaves) {
        const result = evaluateLeaf(leaf, capabilityIds, workspaceRoot, true);
        if (!result.allowed)
            return result;
    }
    return allowed('Parser-proven safe compound read command.');
}
function evaluateLeaf(leaf, capabilityIds, workspaceRoot, stdinOk) {
    if (leaf.redirects.length > 0 || leaf.argv.some(isSecretLikeValue)) {
        return blocked('Secret or redirected reads require approval.');
    }
    const executable = bashExecutableName(leaf.argv[0] ?? '');
    if (leaf.argv[0] !== executable) {
        return blocked('Executable path is not an exact reviewed read command.');
    }
    const args = leaf.argv.slice(1);
    if (BARE_SAFE_EXECUTABLES.has(executable)) {
        return allowed(`Known-safe command ${executable}.`);
    }
    if (executable === 'sed') {
        const fileArgs = sedReadFileArgs(args);
        if (!fileArgs)
            return blockedReadShape('read');
        return evaluateFileRead('read', fileArgs, capabilityIds, !stdinOk, workspaceRoot);
    }
    if (executable === 'ls') {
        const fileArgs = collectPlainFileArgs(args, isLsArg);
        if (!fileArgs)
            return blockedReadShape('list');
        return evaluateFileRead('list', fileArgs, capabilityIds, false, workspaceRoot);
    }
    if (executable === 'cat') {
        const fileArgs = collectPlainFileArgs(args, isCatArg);
        if (!fileArgs)
            return blockedReadShape('read');
        return evaluateFileRead('read', fileArgs, capabilityIds, !stdinOk, workspaceRoot);
    }
    if (executable === 'pwd') {
        if (!args.every((arg) => /^-[LP]$/.test(arg))) {
            return blockedReadShape('read');
        }
        return evaluateFileRead('read', ['.'], capabilityIds, false, workspaceRoot);
    }
    if (executable === 'which') {
        const names = args.filter((arg) => !/^-(?:a|s)$/.test(arg));
        if (names.length === 0 ||
            args.some((arg) => arg.startsWith('-') && !/^-(?:a|s)$/.test(arg)) ||
            names.some((name) => !/^[A-Za-z0-9_.+-]+$/.test(name))) {
            return blockedReadShape('read');
        }
        return evaluateFileRead('read', ['.'], capabilityIds, false, workspaceRoot);
    }
    if (executable === 'grep') {
        const fileArgs = grepFileArgs(args);
        if (!fileArgs)
            return blockedReadShape('read');
        return evaluateFileRead('read', fileArgs, capabilityIds, !stdinOk, workspaceRoot);
    }
    if (GENERIC_READ_EXECUTABLES.has(executable)) {
        const fileArgs = genericReadFileArgs(executable, args);
        if (!fileArgs)
            return blockedReadShape('read');
        return evaluateFileRead('read', fileArgs, capabilityIds, false, workspaceRoot);
    }
    const fileArgs = simpleReadFileArgs(executable, args);
    if (fileArgs) {
        return evaluateFileRead('read', fileArgs, capabilityIds, executable !== 'du' && !stdinOk, workspaceRoot);
    }
    return blocked(`Executable ${executable || '(missing)'} is not a reviewed read command.`);
}
function evaluateFileRead(action, fileArgs, capabilityIds, requiresTarget, workspaceRoot) {
    if ((requiresTarget && fileArgs.length === 0) ||
        fileArgs.some((arg) => !isProvablyWorkspacePath(arg))) {
        return blocked(`The file ${action} command shape is not provably safe.`);
    }
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
        return blocked(`The file ${action} requires an absolute workspace root.`);
    }
    let resolvedWorkspaceRoot;
    try {
        resolvedWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    }
    catch {
        return blocked(`The file ${action} workspace root could not be resolved.`);
    }
    // This pre-execution check is sound because the runner cannot create symlinks
    // without a separately-approved write: Write/Edit create regular files, and
    // `ln -s` via Bash is not in the silent set.
    for (const fileArg of fileArgs.length > 0 ? fileArgs : ['.']) {
        let resolvedTarget;
        try {
            resolvedTarget = fs.realpathSync.native(path.resolve(resolvedWorkspaceRoot, fileArg));
        }
        catch {
            return blocked(`The file ${action} target could not be resolved.`);
        }
        if (!isWithinPath(resolvedWorkspaceRoot, resolvedTarget)) {
            return blocked(`The resolved file ${action} target is not safe.`);
        }
        // Hidden/secret checks apply to the workspace-relative part only: the
        // root itself is host-provisioned (GANTRY_HOME may legitimately be a
        // dotted path), while everything below it is agent-influenced.
        const relativeTarget = path.relative(resolvedWorkspaceRoot, resolvedTarget);
        if (hasHiddenPathSegment(relativeTarget) ||
            allProtectedPathMentions(resolvedTarget).length > 0 ||
            SECRET_PATH.test(relativeTarget)) {
            return blocked(`The resolved file ${action} target is not safe.`);
        }
    }
    const boundary = capabilityIds.find((id) => {
        const tokens = capabilityTokens(id);
        return (tokens.length === 2 &&
            FILE_CAPABILITY_DOMAINS.has(tokens[0] ?? '') &&
            (tokens.at(-1) === action || tokens.at(-1) === 'read'));
    });
    if (!boundary) {
        return blocked(`No approved file ${action} capability boundary matches.`);
    }
    return allowed(`Parser-proven file ${action} within ${boundary}.`);
}
function evaluateMcpRead(canonicalToolName, toolInput, capabilityIds, reviewedMcpReadBindings) {
    const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_.-]+)$/.exec(canonicalToolName);
    if (!match || match[1] === 'gantry') {
        return blocked('Tool family has no deterministic read-only proof.');
    }
    if (containsSecretLikeInput(toolInput)) {
        return blocked('Secret-bearing MCP reads require approval.');
    }
    const toolTokens = capabilityTokens(`${match[1]}.${match[2]}`);
    if (toolTokens.some(isSecretResourceToken)) {
        return blocked('MCP action targets a secret or credential resource.');
    }
    const reviewedBinding = reviewedMcpReadBindings?.find((binding) => mcpToolPatternCovers(binding.toolPattern.trim(), canonicalToolName));
    if (!reviewedBinding) {
        return blocked('MCP action lacks reviewed read-only action metadata.');
    }
    const reviewedCapability = capabilityIds.find((id) => id === normalizeCapabilityId(reviewedBinding.capabilityId));
    if (!reviewedCapability) {
        return blocked('No approved capability boundary covers this reviewed MCP read action.');
    }
    return allowed(`Reviewed MCP read action within ${reviewedCapability}.`);
}
function isLsArg(arg) {
    return (arg === '--' ||
        !arg.startsWith('-') ||
        LS_OPTIONS.test(arg) ||
        LS_LONG_OPTIONS.test(arg));
}
function isCatArg(arg) {
    return arg === '--' || !arg.startsWith('-') || CAT_OPTIONS.has(arg);
}
function isProvablyWorkspacePath(value) {
    if (!value || value.startsWith('~'))
        return false;
    // Hidden segments (.npmrc, .netrc, .aws/…) are where credentials live;
    // they are never provably non-secret, so they always ask.
    return !hasHiddenPathSegment(value);
}
function parseGateCommand(command) {
    return parseBashCommand(command);
}
function collectPlainFileArgs(args, validArg) {
    const fileArgs = [];
    let optionsEnded = false;
    for (const arg of args) {
        if (!optionsEnded && arg === '--') {
            optionsEnded = true;
        }
        else if (!validArg(arg)) {
            return undefined;
        }
        else if (optionsEnded || !arg.startsWith('-')) {
            fileArgs.push(arg);
        }
    }
    return fileArgs;
}
function simpleReadFileArgs(executable, args) {
    const options = {
        stat: /^-[Flnqrstx]+$/,
        file: /^-[bikLNsvz]+$|^--(?:brief|dereference|mime|mime-type|special-files)$/,
        wc: /^-[clmwL]+$|^--(?:bytes|chars|lines|max-line-length|words)$/,
        du: /^-[achksx]+$|^-d\d+$|^--max-depth=\d+$/,
        df: /^-[hiklmPT]+$/,
    };
    const option = options[executable];
    if (option) {
        return collectPlainFileArgs(args, (arg) => arg === '--' || !arg.startsWith('-') || option.test(arg));
    }
    if (executable !== 'head' && executable !== 'tail')
        return undefined;
    const fileArgs = [];
    let optionsEnded = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!optionsEnded && arg === '--') {
            optionsEnded = true;
        }
        else if (optionsEnded || !arg.startsWith('-')) {
            fileArgs.push(arg);
        }
        else if (/^-[qvz]+$|^-[nc]?\d+$|^--(?:bytes|lines)=\d+$/.test(arg)) {
            continue;
        }
        else if (/^(?:-[nc]|--bytes|--lines)$/.test(arg)) {
            if (!/^\d+$/.test(args[index + 1] ?? ''))
                return undefined;
            index += 1;
        }
        else {
            return undefined;
        }
    }
    return fileArgs;
}
function grepFileArgs(args) {
    const noValueOption = /^-(?:[EFGHILTZabchilnoqsvwxyz]+)$|^--(?:basic-regexp|extended-regexp|fixed-strings|ignore-case|line-number|no-messages|only-matching|quiet|text|word-regexp|with-filename)$/;
    const valueOption = /^(?:-A|-B|-C|-m|--after-context|--before-context|--context|--max-count)$/;
    const fileArgs = [];
    let patternSeen = false;
    let optionsEnded = false;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!optionsEnded && arg === '--') {
            optionsEnded = true;
            continue;
        }
        if (!optionsEnded && /^(?:-e|--regexp)$/.test(arg)) {
            if (!args[index + 1])
                return undefined;
            patternSeen = true;
            index += 1;
            continue;
        }
        if (!optionsEnded && /^-e.+/.test(arg)) {
            patternSeen = true;
            continue;
        }
        if (!optionsEnded && /^(?:-d.*|--directories(?:=.*)?)$/.test(arg)) {
            return undefined;
        }
        if (!optionsEnded && valueOption.test(arg)) {
            if (!args[index + 1])
                return undefined;
            index += 1;
            continue;
        }
        if (!optionsEnded && arg.startsWith('-')) {
            if (!noValueOption.test(arg))
                return undefined;
            continue;
        }
        if (!patternSeen)
            patternSeen = true;
        else
            fileArgs.push(arg);
    }
    return patternSeen && fileArgs.length > 0 ? fileArgs : undefined;
}
function blockedReadShape(action) {
    return blocked(`The file ${action} command shape is not provably safe.`);
}
function isWithinPath(base, candidate) {
    const relative = path.relative(base, candidate);
    return (relative === '' ||
        (!path.isAbsolute(relative) &&
            relative !== '..' &&
            !relative.startsWith(`..${path.sep}`)));
}
function containsSecretLikeInput(value, key) {
    if (key && isSecretInputKey(key))
        return true;
    if (typeof value === 'string') {
        return isSecretLikeValue(value) || SECRET_VALUE.test(value);
    }
    if (Array.isArray(value)) {
        return value.some((item) => containsSecretLikeInput(item));
    }
    if (!value || typeof value !== 'object')
        return false;
    return Object.entries(value).some(([childKey, child]) => containsSecretLikeInput(child, childKey));
}
function isSecretLikeValue(value) {
    return SECRET_PATH.test(value);
}
// Exact-match selectors that name a profile, never secret material.
const BENIGN_SELECTOR_KEYS = new Set(['credential_profile_ref']);
function isSecretInputKey(key) {
    // Secret tokens win over id/name/ref suffixes: secretId, tokenRef, and
    // credentialId all select secret material and must ask.
    const normalized = key
        .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase();
    if (BENIGN_SELECTOR_KEYS.has(normalized))
        return false;
    return SECRET_KEY.test(normalized);
}
function isSecretResourceToken(token) {
    return /^(?:credential|credentials|key|keys|password|secret|secrets|token|tokens)$/.test(token);
}
function commandText(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return undefined;
    }
    const record = input;
    const value = record.command ?? record.cmd;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function allowed(reason) {
    return { allowed: true, reason };
}
function blocked(reason) {
    return { allowed: false, reason };
}
