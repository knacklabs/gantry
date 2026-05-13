import { describe, expect, it } from 'vitest';

import { denyProtectedCapabilityToolUse } from '@core/runner/claude/protected-capability-guard.js';

describe('denyProtectedCapabilityToolUse', () => {
  it('denies Config because it can mutate agent capability policy', () => {
    expect(
      denyProtectedCapabilityToolUse('Config', {
        setting: 'permissions.defaultMode',
      }),
    ).toContain('Denied by MyClaw tool execution policy');
  });

  it.each([
    ['Write', { file_path: '/repo/.mcp.json', content: '{}' }],
    [
      'Edit',
      {
        file_path: '/repo/.claude/settings.json',
        old_string: '{}',
        new_string: '{"permissions":{"allow":["Bash(npm test *)"]}}',
      },
    ],
    ['MultiEdit', { file_path: '/repo/.agents/skills/tool/SKILL.md' }],
    ['Bash', { command: 'cat > .mcp.json' }],
  ])('denies %s mutations to capability-bearing files', (tool, input) => {
    expect(denyProtectedCapabilityToolUse(tool, input)).toContain(
      'Denied by MyClaw tool execution policy',
    );
  });

  it('allows unrelated or targetless tool requests', () => {
    expect(
      denyProtectedCapabilityToolUse('Write', {
        file_path: '/repo/docs/notes.md',
        content: 'hello',
      }),
    ).toBeNull();
    expect(
      denyProtectedCapabilityToolUse('NotebookEdit', {
        new_source: 'permissionMode = bypassPermissions',
      }),
    ).toBeNull();
    expect(
      denyProtectedCapabilityToolUse('Bash', {
        command:
          'gh issue create --title docs --body "mention .mcp.json and mcpServers"',
      }),
    ).toBeNull();
  });
});
