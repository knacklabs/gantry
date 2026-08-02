export const RESERVED_SDK_NATIVE_SKILL_NAMES = [
    'batch',
    'commands',
    'debug',
    'dream',
    'init',
    'keybindings-help',
    'less-permission-prompts',
    'loop',
    'review',
    'schedule',
    'security-review',
    'simplify',
    'update-config',
    // Provider-native reserved names (Claude adapter). Install-time validation
    // must reject them too: a skill materializing to one of these directories
    // passes install but fails the NEXT spawn in the Claude materializer.
    'claude-api',
    'claude-in-chrome',
];
const RESERVED_SDK_NATIVE_SKILL_NAME_SET = new Set(RESERVED_SDK_NATIVE_SKILL_NAMES);
export function reservedSdkNativeSkillNameFor(skillName) {
    const normalized = normalizeSdkNativeSkillName(skillName);
    return RESERVED_SDK_NATIVE_SKILL_NAME_SET.has(normalized) ? normalized : null;
}
export function isSdkNativeReservedSkillName(skillName) {
    return reservedSdkNativeSkillNameFor(skillName) !== null;
}
export function normalizeSdkNativeSkillName(value) {
    const safe = value
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^\.+/, '')
        .slice(0, 120);
    return (safe || 'skill').toLowerCase();
}
