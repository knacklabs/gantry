import { describe, expect, it } from 'vitest';

import type { AgentExecutionAdapter } from '@core/application/agent-execution/agent-execution-adapter.js';
import {
  hasWarmPoolCapability,
  poolKeyOf,
  type WarmPoolKeyInput,
} from '@core/application/agent-execution/warm-pool-capable.js';

function baseKeyInput(
  overrides: Partial<WarmPoolKeyInput> = {},
): WarmPoolKeyInput {
  return {
    providerId: 'anthropic:claude-agent-sdk',
    appId: 'app-1',
    agentId: 'agent-1',
    persona: 'sales',
    model: 'opus',
    toolSurface: {
      gantryMcp: ['send_message', 'mcp_call_tool'],
      native: ['Read', 'Skill'],
    },
    mcpSet: ['mcp:shopify-api', 'mcp:boondi-crm'],
    thinking: { mode: 'enabled', effort: 'medium' },
    systemPromptVersion: 'prompt-v1',
    ...overrides,
  };
}

describe('warm-pool capability contract', () => {
  it('builds a stable key for the same boot-affecting input', () => {
    expect(poolKeyOf(baseKeyInput())).toBe(poolKeyOf(baseKeyInput()));
  });

  it.each([
    ['providerId', { providerId: 'openai:responses' }],
    ['appId', { appId: 'app-2' }],
    ['agentId', { agentId: 'agent-2' }],
    ['persona', { persona: 'operations' }],
    ['model', { model: 'sonnet' }],
    ['toolSurface', { toolSurface: { gantryMcp: ['send_message'] } }],
    ['mcpSet', { mcpSet: ['mcp:shopify-api'] }],
    ['thinking', { thinking: { mode: 'enabled', effort: 'high' } }],
    ['systemPromptVersion', { systemPromptVersion: 'prompt-v2' }],
  ] satisfies Array<[string, Partial<WarmPoolKeyInput>]>)(
    'distinguishes %s in the pool key',
    (_field, overrides) => {
      expect(poolKeyOf(baseKeyInput(overrides))).not.toBe(
        poolKeyOf(baseKeyInput()),
      );
    },
  );

  it('normalizes set-like fields so source ordering does not fragment a pool', () => {
    const first = poolKeyOf(baseKeyInput());
    const second = poolKeyOf(
      baseKeyInput({
        toolSurface: {
          gantryMcp: ['mcp_call_tool', 'send_message'],
          native: ['Skill', 'Read'],
        },
        mcpSet: ['mcp:boondi-crm', 'mcp:shopify-api'],
      }),
    );

    expect(second).toBe(first);
  });

  it('detects adapters that implement the warm-pool verbs', () => {
    const capable = {
      id: 'anthropic:claude-agent-sdk',
      prepare: async () => {
        throw new Error('not used');
      },
      prewarm: async () => {
        throw new Error('not used');
      },
      bind: async () => {
        throw new Error('not used');
      },
      recycle: async () => undefined,
    } satisfies AgentExecutionAdapter;

    expect(hasWarmPoolCapability(capable)).toBe(true);
    expect(
      hasWarmPoolCapability({
        id: 'anthropic:claude-agent-sdk',
        prepare: async () => {
          throw new Error('not used');
        },
      }),
    ).toBe(false);
  });
});
