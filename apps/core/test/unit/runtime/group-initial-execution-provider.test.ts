import { describe, expect, it } from 'vitest';

import { resolveInitialGroupExecutionProviderId } from '@core/runtime/group-initial-execution-provider.js';

describe('resolveInitialGroupExecutionProviderId', () => {
  it('uses the effective interactive default when the route has no model override', async () => {
    const resolved = await resolveInitialGroupExecutionProviderId({
      group: { folder: 'alpha' },
      appId: 'default',
      defaultModel: 'gpt-5.5',
      executionAdapter: { id: 'anthropic:claude-agent-sdk' },
      agentHarness: 'auto',
      listConfiguredProviders: async () => new Set(['openai']),
    });

    expect(resolved.initialModelSelection.model?.runnerModel).toBe('gpt-5.5');
    expect(resolved.executionProviderId).toBe('deepagents:langchain');
  });
});
