import { RESERVED_SDK_NATIVE_SKILL_NAMES, normalizeSdkNativeSkillName, } from '../../../shared/sdk-native-skill-names.js';
const PROVIDER_NATIVE_RESERVED_SKILL_NAMES = [
    'claude-api',
    'claude-in-chrome',
];
export const CLAUDE_NATIVE_RESERVED_SKILL_NAMES = [
    ...RESERVED_SDK_NATIVE_SKILL_NAMES,
    ...PROVIDER_NATIVE_RESERVED_SKILL_NAMES,
];
const CLAUDE_NATIVE_RESERVED_SKILL_NAME_SET = new Set(CLAUDE_NATIVE_RESERVED_SKILL_NAMES);
export function isClaudeNativeReservedSkillName(skillName) {
    return CLAUDE_NATIVE_RESERVED_SKILL_NAME_SET.has(normalizeSdkNativeSkillName(skillName));
}
export const SDK_NATIVE_SKILL_DISABLE_ENV = {
    CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1',
};
/**
 * Claude Code can register first-party skills before Gantry's per-run skill
 * directory is discovered. Keep the SDK-native Skill tool available, but hide
 * non-Gantry built-ins and managed policy skills from the runtime skill list.
 */
export const SDK_NATIVE_SKILL_OVERRIDES = Object.fromEntries(CLAUDE_NATIVE_RESERVED_SKILL_NAMES.map((skillName) => [skillName, 'off']));
export const GANTRY_CLAUDE_SDK_SKILLS_ENV = 'GANTRY_CLAUDE_SDK_SKILLS_JSON';
export function claudeSdkSkillNamesForMaterializedSkills(skills) {
    const blocked = skills
        .map((skill) => skill.materializedName || skill.name)
        .filter(isClaudeNativeReservedSkillName);
    if (blocked.length > 0) {
        throw new Error(`Materialized Gantry skills cannot use Claude-native reserved names: ${[
            ...new Set(blocked),
        ]
            .sort()
            .join(', ')}`);
    }
    return [
        ...new Set(skills
            .map((skill) => skill.materializedName || skill.name)
            .filter((name) => name.trim().length > 0)),
    ].sort();
}
export function readClaudeSdkSkillNamesFromEnv(env = process.env) {
    const raw = env[GANTRY_CLAUDE_SDK_SKILLS_ENV];
    if (!raw)
        return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) ||
        parsed.some((item) => typeof item !== 'string')) {
        throw new Error(`${GANTRY_CLAUDE_SDK_SKILLS_ENV} must be a JSON string array.`);
    }
    return [...new Set(parsed.filter((item) => item.trim().length > 0))].sort();
}
