import { describe, expect, it } from 'vitest';

import { resolveConfiguredAllowedTools } from '@core/runtime/configured-agent-tools.js';

describe('configured agent tools', () => {
  it('resolves namespaced permission-rule catalog rows to their SDK rule names', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:permission-rule:abc123',
        },
      ],
      getTool: async () => ({
        name: 'Bash(npm test)',
      }),
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual(['Bash(npm test)']);
  });

  it('keeps the legacy tool id fallback when a catalog row is unavailable', async () => {
    const repository = {
      listAgentToolBindings: async () => [
        {
          status: 'active',
          toolId: 'tool:Bash',
        },
      ],
      getTool: async () => null,
    };

    await expect(
      resolveConfiguredAllowedTools({
        repository: repository as never,
        appId: 'default',
        agentId: 'agent:one',
      }),
    ).resolves.toEqual(['Bash']);
  });
});
