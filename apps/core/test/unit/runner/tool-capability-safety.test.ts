import { describe, expect, it } from 'vitest';

import { composeAgentCapabilities } from '@agent-runner-src/agent-capabilities.js';
import { evaluateProtectedCapabilityToolUse } from '@agent-runner-src/claude/protected-capability-hook.js';

describe('tool capability safety', () => {
  it('does not grant dangerous native tools or wildcard MyClaw MCP tools by default', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      groupFolder: 'telegram_team',
      isMain: false,
    });

    expect(profile.allowedTools).toContain(
      'mcp__myclaw__request_skill_install',
    );
    expect(profile.allowedTools).toContain(
      'mcp__myclaw__request_channel_tool_enable',
    );
    expect(profile.allowedTools).not.toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'mcp__myclaw__*']),
    );
  });

  it('forces direct capability mutation through request tools', () => {
    expect(
      evaluateProtectedCapabilityToolUse('Bash', {
        command: 'claude mcp add-json github {"type":"http"}',
      }),
    ).toEqual(
      expect.objectContaining({
        reason: expect.stringContaining('MCP'),
      }),
    );
    expect(
      evaluateProtectedCapabilityToolUse(
        'mcp__myclaw__request_skill_dependency_install',
        { manager: 'npm', package: '@example/tool' },
      ),
    ).toBeNull();
  });
});
