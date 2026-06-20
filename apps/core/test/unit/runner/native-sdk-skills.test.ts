import { describe, expect, it } from 'vitest';

import { claudeSdkToolsForEnabledSkills } from '@core/adapters/llm/anthropic-claude-agent/native-sdk-skills.js';

describe('native SDK skills', () => {
  it('exposes the native Skill tool when SDK skills are enabled under a restricted tool surface', () => {
    expect(claudeSdkToolsForEnabledSkills(['ToolSearch'], ['boondi-kb'])).toEqual(
      ['ToolSearch', 'Skill'],
    );
  });

  it('does not expose Skill when no SDK skills are enabled', () => {
    expect(claudeSdkToolsForEnabledSkills(['ToolSearch'], [])).toEqual([
      'ToolSearch',
    ]);
  });
});
