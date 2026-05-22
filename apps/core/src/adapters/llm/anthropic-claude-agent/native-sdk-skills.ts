/**
 * Claude Code can register first-party skills before Gantry's per-run skill
 * directory is discovered. Keep the SDK-native Skill tool available, but hide
 * non-Gantry built-ins and managed policy skills from the runtime skill list.
 */
export const SDK_NATIVE_SKILL_DISABLE_ENV = {
  CLAUDE_CODE_DISABLE_POLICY_SKILLS: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_API_SKILL: '1',
} as const;

export const SDK_NATIVE_SKILL_OVERRIDES = {
  batch: 'off',
  'claude-api': 'off',
  'claude-in-chrome': 'off',
  debug: 'off',
  dream: 'off',
  'keybindings-help': 'off',
  'less-permission-prompts': 'off',
  loop: 'off',
  schedule: 'off',
  simplify: 'off',
  'update-config': 'off',
} as const;
