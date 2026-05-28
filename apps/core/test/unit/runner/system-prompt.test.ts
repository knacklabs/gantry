import { describe, expect, it } from 'vitest';

import { buildRunnerSystemPrompt } from '@core/adapters/llm/anthropic-claude-agent/runner/system-prompt.js';
import type { AgentRunnerInput } from '@core/adapters/llm/anthropic-claude-agent/runner/types.js';

function baseInput(
  overrides: Partial<AgentRunnerInput> = {},
): AgentRunnerInput {
  return {
    prompt: 'hello',
    groupFolder: 'boondi_support',
    chatJid: 'wa:919654405340',
    compiledSystemPrompt: 'Base prompt.',
    ...overrides,
  };
}

describe('buildRunnerSystemPrompt', () => {
  it('names approved MCP services and tells agents to inspect them for customer data', () => {
    const prompt = buildRunnerSystemPrompt(baseInput(), '', {
      approvedMcpServerNames: ['customer-api'],
    });

    expect(prompt?.append).toContain('Approved MCP Services');
    expect(prompt?.append).toContain('customer-api');
    expect(prompt?.append).toContain('call mcp_list_tools first');
    expect(prompt?.append).toContain('mcp_call_tool');
    expect(prompt?.append).toContain('MCP tools enforce their own access');
    // Customer-facing denial phrasing is persona-owned (SOUL.md / CLAUDE.md),
    // not baked into the provider-neutral runner prompt for every MCP run.
    expect(prompt?.append).not.toContain('Do not mention internal tool names');
    expect(prompt?.append).not.toContain(
      'does not match the phone number they are messaging from',
    );
  });

  it('omits the approved MCP section when no services are present', () => {
    const prompt = buildRunnerSystemPrompt(baseInput(), '', {
      approvedMcpServerNames: [],
    });

    expect(prompt?.append).not.toContain('Approved MCP Services');
  });
});
