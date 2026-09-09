import { describe, expect, it, vi } from 'vitest';

import { ProviderSessionMeasurementError } from '@core/domain/sessions/provider-session-measurement.js';
import { raiseProviderSessionContextHighWaterMark } from '@core/adapters/storage/postgres/repositories/canonical-session-repository-context-mark.postgres.js';

describe('provider session measurement', () => {
  it('rejects non-integer and negative values before SQL', async () => {
    const executor = { update: vi.fn() };
    const input = {
      providerSessionId: 'provider-session:1',
      agentSessionId: 'agent-session:1',
      provider: 'anthropic:claude-agent-sdk' as never,
      externalSessionId: 'external-session:1',
      expectedAgentSessionResetAt: null,
      contextHighWaterMark: 1.5,
    };

    await expect(
      raiseProviderSessionContextHighWaterMark(executor as never, input),
    ).rejects.toBeInstanceOf(ProviderSessionMeasurementError);
    await expect(
      raiseProviderSessionContextHighWaterMark(executor as never, {
        ...input,
        contextHighWaterMark: -1,
      }),
    ).rejects.toBeInstanceOf(ProviderSessionMeasurementError);
    expect(executor.update).not.toHaveBeenCalled();
  });
});
