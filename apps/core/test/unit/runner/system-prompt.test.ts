import { describe, expect, it } from 'vitest';

import { buildRunnerSystemPrompt } from '@agent-runner-src/claude/system-prompt.js';
import type { AgentRunnerInput } from '@agent-runner-src/claude/types.js';

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
    expect(prompt?.append).toContain('Do not mention internal tool names');
    expect(prompt?.append).toContain(
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
