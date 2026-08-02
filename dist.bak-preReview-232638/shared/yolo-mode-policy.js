import { parseBashCommand } from './bash-command-parser.js';
// Provider-neutral deny copy for a yolo-mode denylist hit. The SDK lane routes a
// match back to an explicit prompt (tool-permission-events.ts); the neutral lane
// has no auto-approve surface yet, so a match is a hard deny to the model. Both
// reference the matched pattern so the operator/model can see why.
export function yoloModeDenylistDenyReason(match) {
    return `Denied by Gantry auto-approve denylist: a YOLO-mode denylist rule matched "${match.pattern}", so this tool cannot be auto-approved. Ask the operator to approve it explicitly.`;
}
export const DEFAULT_YOLO_MODE_DENYLIST = [
    'sudo *',
    'rm -rf /',
    'rm -rf /*',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf ~/*',
    'git push --force * main|master',
    'git push -f * main|master',
    ':(){ :|:& };:',
];
export const DEFAULT_YOLO_MODE_DENYLIST_PATHS = [
    '/etc/*',
    '/System/*',
    '/usr/*',
    '/bin/*',
    '/sbin/*',
];
const FILE_PATH_FIELDS = [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'notebookPath',
];
export function effectiveYoloModeSettings(settings) {
    return {
        enabled: settings.enabled,
        denylist: uniqueStable([
            ...DEFAULT_YOLO_MODE_DENYLIST,
            ...settings.denylist,
        ]),
        denylistPaths: uniqueStable([
            ...DEFAULT_YOLO_MODE_DENYLIST_PATHS,
            ...settings.denylistPaths,
        ]),
    };
}
export function evaluateYoloModeDenylist(input) {
    const settings = input.settings;
    if (!settings?.enabled)
        return undefined;
    const effective = effectiveYoloModeSettings(settings);
    for (const command of extractCommandCandidates(input.toolName, input.toolInput)) {
        for (const pattern of effective.denylist) {
            if (commandPatternMatches(pattern, command)) {
                return { kind: 'command', pattern, toolName: input.toolName };
            }
        }
    }
    for (const path of extractPathCandidates(input.toolName, input.toolInput)) {
        for (const pattern of effective.denylistPaths) {
            if (pathPatternMatches(pattern, path)) {
                return { kind: 'path', pattern, toolName: input.toolName };
            }
        }
    }
    return undefined;
}
// Both shell tool spellings carry a command string: SDK-native Bash and the
// canonical RunCommand used by IPC/classifier paths.
function isShellCommandTool(toolName) {
    return toolName === 'Bash' || toolName === 'RunCommand';
}
function shellCommandVariants(toolInput) {
    const command = commandText(toolInput);
    return command ? [command] : [];
}
function extractCommandCandidates(toolName, toolInput) {
    if (!isShellCommandTool(toolName))
        return [];
    const candidates = [];
    for (const command of shellCommandVariants(toolInput)) {
        const parsed = parseBashCommand(command);
        candidates.push(command);
        if (parsed.ok) {
            candidates.push(...parsed.leaves.map((leaf) => leaf.commandText));
        }
    }
    return uniqueStable(candidates);
}
function extractPathCandidates(toolName, toolInput) {
    const paths = [];
    if (isShellCommandTool(toolName)) {
        for (const command of shellCommandVariants(toolInput)) {
            const parsed = parseBashCommand(command);
            if (parsed.ok) {
                for (const leaf of parsed.leaves) {
                    paths.push(...leaf.argv.slice(1));
                    paths.push(...leaf.redirects.map((redirect) => redirect.target));
                }
            }
            else {
                paths.push(...splitShellish(command));
            }
        }
        return uniqueStable(paths.filter(isPathToken));
    }
    collectPathFields(toolInput, paths);
    return uniqueStable(paths.filter(isPathToken));
}
function collectPathFields(value, paths) {
    if (!value || typeof value !== 'object')
        return;
    if (Array.isArray(value)) {
        for (const item of value)
            collectPathFields(item, paths);
        return;
    }
    const record = value;
    for (const field of FILE_PATH_FIELDS) {
        const path = record[field];
        if (typeof path === 'string' && path.trim())
            paths.push(path.trim());
    }
    for (const nested of Object.values(record)) {
        if (nested && typeof nested === 'object')
            collectPathFields(nested, paths);
    }
}
function commandText(input) {
    if (!input || typeof input !== 'object')
        return undefined;
    const record = input;
    // RunCommand accepts `cmd` as a command alias. Prefer whichever field is a
    // usable string — a non-string `command` must not mask a real `cmd`.
    for (const value of [record.command, record.cmd]) {
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
function commandPatternMatches(pattern, command) {
    if (isForkBombPattern(pattern)) {
        return compactShell(command).includes(compactShell(pattern));
    }
    const patternTokens = splitShellish(pattern);
    const commandTokens = splitShellish(command);
    if (patternTokens.length === 0 || commandTokens.length === 0)
        return false;
    const trailingRestWildcard = patternTokens.at(-1) === '*';
    if (trailingRestWildcard) {
        if (commandTokens.length < patternTokens.length)
            return false;
    }
    else if (commandTokens.length !== patternTokens.length) {
        return false;
    }
    for (let index = 0; index < patternTokens.length; index += 1) {
        const tokenPattern = patternTokens[index];
        if (tokenPattern === '*' && index === patternTokens.length - 1)
            return true;
        const token = commandTokens[index];
        if (token === undefined)
            return false;
        if (!tokenPatternMatches(tokenPattern, token))
            return false;
    }
    return trailingRestWildcard || commandTokens.length === patternTokens.length;
}
function tokenPatternMatches(pattern, value) {
    if (pattern === '*')
        return true;
    const alternatives = pattern.split('|');
    return alternatives.some((alternative) => globPatternMatches(alternative, value));
}
function isPathToken(value) {
    const trimmed = value.trim();
    return (trimmed.startsWith('/') ||
        trimmed.startsWith('~/') ||
        trimmed === '~' ||
        trimmed.startsWith('$HOME/'));
}
function isForkBombPattern(pattern) {
    return compactShell(pattern) === compactShell(':(){ :|:& };:');
}
function compactShell(value) {
    return value.replace(/\s+/g, '');
}
function splitShellish(value) {
    return value
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
}
function globPatternMatches(pattern, value) {
    if (!pattern.includes('*'))
        return pattern === value;
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`);
    return regex.test(value);
}
function pathPatternMatches(pattern, value) {
    if (pattern.endsWith('/*') && value === pattern.slice(0, -2))
        return true;
    return globPatternMatches(pattern, value);
}
function escapeRegex(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
function uniqueStable(values) {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
