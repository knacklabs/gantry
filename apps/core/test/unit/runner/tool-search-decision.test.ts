import { describe, expect, it } from 'vitest';

import {
  decideClaudeSdkToolSearch,
  toolSearchStartupRuntimeEvent,
} from '@core/adapters/llm/anthropic-claude-agent/runner/tool-search-decision.js';

const baseUrlEnvKey = ['ANTHROPIC', 'BASE', 'URL'].join('_');
const apiKeyEnvKey = ['ANTHROPIC', 'API', 'KEY'].join('_');
const anthropicSdkProvider = ['anthropic', 'sdk'].join('_');

describe('Claude SDK ToolSearch decision', () => {
  it('uses the SDK auto threshold for first-party Anthropic routing', () => {
    const decision = decideClaudeSdkToolSearch({
      sdkEnv: { [baseUrlEnvKey]: 'https://api.anthropic.com' },
      availableTools: ['Read', 'ToolSearch'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: { gantry: { command: 'node' } },
    });

    expect(decision).toMatchObject({
      enableToolSearch: 'auto:10',
      reason: 'official_auto_threshold',
      anthropicBaseUrlKind: 'first_party',
      availableToolCount: 2,
      allowedToolCount: 1,
      disallowedToolCount: 1,
      mcpServerCount: 1,
    });
    expect(decision.serializedToolConfigBytes).toBeGreaterThan(0);
  });

  it('disables ToolSearch when Gantry or another proxy has not proved tool_reference support', () => {
    const decision = decideClaudeSdkToolSearch({
      sdkEnv: { [baseUrlEnvKey]: 'http://127.0.0.1:18789/v1' },
      availableTools: ['Read', 'ToolSearch'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: { gantry: { command: 'node' } },
    });

    expect(decision).toMatchObject({
      enableToolSearch: 'false',
      reason: 'non_first_party_base_url_tool_reference_unproven',
      anthropicBaseUrlKind: 'non_first_party',
    });
  });

  it('uses the SDK auto threshold for Gantry loopback gateway routing', () => {
    const decision = decideClaudeSdkToolSearch({
      sdkEnv: {
        [baseUrlEnvKey]: 'http://127.0.0.1:18789/anthropic',
        [apiKeyEnvKey]: 'gtw_run_scoped_token',
      },
      availableTools: ['Read', 'ToolSearch'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: { gantry: { command: 'node' } },
    });

    expect(decision).toMatchObject({
      enableToolSearch: 'auto:10',
      reason: 'gantry_gateway_tool_reference_pass_through',
      anthropicBaseUrlKind: 'gantry_loopback',
    });
  });

  it('keeps arbitrary loopback proxies disabled without a Gantry gateway token', () => {
    const decision = decideClaudeSdkToolSearch({
      sdkEnv: { [baseUrlEnvKey]: 'http://127.0.0.1:18789/anthropic' },
      availableTools: ['Read', 'ToolSearch'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: { gantry: { command: 'node' } },
    });

    expect(decision).toMatchObject({
      enableToolSearch: 'false',
      reason: 'non_first_party_base_url_tool_reference_unproven',
      anthropicBaseUrlKind: 'non_first_party',
    });
  });

  it('emits redacted startup diagnostics without storing raw base URLs', () => {
    const decision = decideClaudeSdkToolSearch({
      sdkEnv: { [baseUrlEnvKey]: 'http://127.0.0.1:18789/v1' },
      availableTools: ['Read', 'ToolSearch'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      mcpServers: { gantry: { command: 'node' } },
    });

    const event = toolSearchStartupRuntimeEvent({
      agentInput: {
        appId: 'app-1',
        agentId: 'agent-1',
        runId: 'run-1',
        workspaceFolder: '/tmp/group',
        chatJid: 'tg:team',
        threadId: 'thread-1',
        prompt: 'hello',
      },
      decision,
    });

    expect(event).toEqual(
      expect.objectContaining({
        eventType: 'run.startup_diagnostic',
        appId: 'app-1',
        agentId: 'agent-1',
        runId: 'run-1',
        conversationId: 'tg:team',
        threadId: 'thread-1',
        actor: 'runtime',
        responseMode: 'none',
      }),
    );
    expect(event.payload).toEqual(
      expect.objectContaining({
        provider: anthropicSdkProvider,
        diagnostic: 'tool_search',
        enableToolSearch: 'false',
        reason: 'non_first_party_base_url_tool_reference_unproven',
        anthropicBaseUrlKind: 'non_first_party',
      }),
    );
    expect(JSON.stringify(event)).not.toContain('127.0.0.1');
  });
});
