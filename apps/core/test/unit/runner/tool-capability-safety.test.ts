import { describe, expect, it } from 'vitest';

import { composeAgentCapabilities } from '@core/adapters/llm/anthropic-claude-agent/agent-capabilities.js';
import { evaluateProtectedCapabilityToolUse } from '@core/adapters/llm/anthropic-claude-agent/runner/protected-capability-hook.js';

describe('tool capability safety', () => {
  it('does not grant dangerous native tools or wildcard Gantry MCP tools by default', () => {
    const profile = composeAgentCapabilities({
      mcpServerPath: '/tmp/ipc-mcp-stdio.js',
      chatJid: 'tg:team',
      workspaceFolder: 'telegram_team',
    });

    expect(profile.allowedTools).toContain(
      'mcp__gantry__request_skill_install',
    );
    expect(profile.allowedTools).toContain('mcp__gantry__request_access');
    expect(profile.allowedTools).not.toContain(
      'mcp__gantry__request_settings_update',
    );
    expect(profile.allowedTools).not.toEqual(
      expect.arrayContaining([
        'Bash',
        'Write',
        'Edit',
        'mcp__gantry__list_models',
        'mcp__gantry__*',
      ]),
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
        'mcp__gantry__request_skill_dependency_install',
        { manager: 'npm', package: '@example/tool' },
      ),
    ).toBeNull();
  });
});
