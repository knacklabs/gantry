export declare const RESERVED_SDK_NATIVE_SKILL_NAMES: readonly ["batch", "commands", "debug", "dream", "init", "keybindings-help", "less-permission-prompts", "loop", "review", "schedule", "security-review", "simplify", "update-config", "claude-api", "claude-in-chrome"];
export declare function reservedSdkNativeSkillNameFor(skillName: string): string | null;
export declare function isSdkNativeReservedSkillName(skillName: string): boolean;
export declare function normalizeSdkNativeSkillName(value: string): string;
