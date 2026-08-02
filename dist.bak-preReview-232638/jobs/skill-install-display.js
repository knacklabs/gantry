import path from 'node:path';
import { toTrimmedString } from './ipc-shared.js';
export function skillInstallCommandDisplayName(payload, commandSummary) {
    const requestedName = toTrimmedString(payload.name, { maxLen: 120 });
    if (requestedName)
        return `skill ${requestedName}`;
    const reasonName = skillNameFromReason(toTrimmedString(payload.reason, { maxLen: 2000 }) || '');
    if (reasonName)
        return `skill ${reasonName}`;
    const commandName = skillNameFromCommandSummary(commandSummary);
    if (commandName)
        return `skill ${commandName}`;
    return 'skill package prepared by the agent';
}
export function formatArgvForDisplay(argv) {
    return argv.map(shellQuoteArg).join(' ');
}
function skillNameFromReason(reason) {
    const namedSkill = reason.match(/\b(?:install|migrate|copy|prepare)\s+(?:the\s+)?(.{2,120}?)\s+skill\b/i);
    if (namedSkill?.[1])
        return normalizeDisplaySkillName(namedSkill[1]);
    const match = reason.match(/\b(?:install|migrate|copy|prepare)\s+(?:the\s+)?(?:skill\s+)?([A-Za-z0-9][A-Za-z0-9._-]{1,80})/i);
    return match?.[1] ?? null;
}
function normalizeDisplaySkillName(value) {
    return value
        .replace(/\bfrom\b.*$/i, '')
        .replace(/\bin\b.*$/i, '')
        .trim()
        .replace(/\s+/g, ' ');
}
function skillNameFromCommandSummary(commandSummary) {
    const pathName = commandSummary
        .split(/\s+/)
        .map((part) => part.replace(/^['"]|['"]$/g, ''))
        .filter((part) => part.includes('/'))
        .map((part) => part.replace(/\/\.?$/, ''))
        .map((part) => path.basename(part))
        .reverse()
        .find((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,80}$/.test(part));
    if (pathName)
        return pathName;
    const installArg = commandSummary.match(/\binstall\s+([A-Za-z0-9][A-Za-z0-9._-]{1,80})\b/i);
    return installArg?.[1] ?? null;
}
function shellQuoteArg(arg) {
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg))
        return arg;
    return `'${arg.replaceAll("'", "'\\''")}'`;
}
