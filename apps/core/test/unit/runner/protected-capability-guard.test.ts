import { describe, expect, it } from 'vitest';

import { denyProtectedCapabilityToolUse } from '@core/runner/claude/protected-capability-guard.js';

describe('denyProtectedCapabilityToolUse', () => {
  it('denies Config because it can mutate agent capability policy', () => {
    expect(
      denyProtectedCapabilityToolUse('Config', { key: 'permissions' }),
    ).toContain('Denied by MyClaw protected-capability guard');
  });

  it.each([
    ['Write', { file_path: '/repo/.mcp.json', content: '{}' }],
    ['Edit', { file_path: '/repo/.claude/settings.json' }],
    ['MultiEdit', { file_path: '/repo/.agents/skills/tool/SKILL.md' }],
    ['NotebookEdit', { new_source: 'permissionMode = bypassPermissions' }],
    ['Bash', { command: 'cat > .mcp.json' }],
  ])('denies %s mutations to capability-bearing files', (tool, input) => {
    expect(denyProtectedCapabilityToolUse(tool, input)).toContain(
      'Denied by MyClaw protected-capability guard',
    );
  });

  it('allows unrelated tool requests', () => {
    expect(
      denyProtectedCapabilityToolUse('Write', {
        file_path: '/repo/docs/notes.md',
        content: 'hello',
      }),
    ).toBeNull();
  });
});
