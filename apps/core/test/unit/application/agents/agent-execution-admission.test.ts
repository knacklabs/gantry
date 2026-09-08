import { describe, expect, it } from 'vitest';

import {
  executionAdmissionForAgent,
  OFFBOARDED_AGENT_EXECUTION_ERROR,
} from '@core/application/agents/agent-execution-admission.js';

describe('executionAdmissionForAgent', () => {
  it('permits execution when the optional agent repository is unavailable', async () => {
    await expect(
      executionAdmissionForAgent({ agentId: 'agent:one' }),
    ).resolves.toBeUndefined();
  });

  it('denies an offboarded AI employee', async () => {
    await expect(
      executionAdmissionForAgent({
        agentId: 'agent:one',
        getAgentRepository: () =>
          ({
            getAgent: async () => ({ status: 'offboarded' }),
          }) as never,
      }),
    ).resolves.toBe(OFFBOARDED_AGENT_EXECUTION_ERROR);
  });
});
