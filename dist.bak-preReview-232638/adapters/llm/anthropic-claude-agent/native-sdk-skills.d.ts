export declare const CLAUDE_NATIVE_RESERVED_SKILL_NAMES: readonly ["batch", "commands", "debug", "dream", "init", "keybindings-help", "less-permission-prompts", "loop", "review", "schedule", "security-review", "simplify", "update-config", "claude-api", "claude-in-chrome", "claude-api", "claude-in-chrome"];
export declare function isClaudeNativeReservedSkillName(skillName: string): boolean;
export declare const SDK_NATIVE_SKILL_DISABLE_ENV: {
    readonly CLAUDE_CODE_DISABLE_POLICY_SKILLS: "1";
    readonly CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: "1";
};
/**
 * Claude Code can register first-party skills before Gantry's per-run skill
 * directory is discovered. Keep the SDK-native Skill tool available, but hide
 * non-Gantry built-ins and managed policy skills from the runtime skill list.
 */
export declare const SDK_NATIVE_SKILL_OVERRIDES: Record<(typeof CLAUDE_NATIVE_RESERVED_SKILL_NAMES)[number], "off">;
export declare const GANTRY_CLAUDE_SDK_SKILLS_ENV = "GANTRY_CLAUDE_SDK_SKILLS_JSON";
export interface ClaudeSdkSkillNameSource {
    name: string;
    materializedName?: string;
}
export declare function claudeSdkSkillNamesForMaterializedSkills(skills: readonly ClaudeSdkSkillNameSource[]): string[];
export declare function readClaudeSdkSkillNamesFromEnv(env?: NodeJS.ProcessEnv): string[];
