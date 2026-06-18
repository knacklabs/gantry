import { describe, expect, it } from 'vitest';

import {
  runFamilyFailoverLoop,
  type FailoverAdvanceDetails,
} from '@core/runtime/failover-candidate-loop.js';
import type { ExecutionProviderId } from '@core/domain/sessions/sessions.js';

describe('runFamilyFailoverLoop onFailover details', () => {
  it('passes the advance details (from/to model + reason) on each failover', async () => {
    const seen: FailoverAdvanceDetails[] = [];
    // Two candidates; the first attempt errors with an eligible (provider) error
    // and no streamed output, so the loop advances to the second candidate.
    const output = await runFamilyFailoverLoop({
      candidates: ['family-a', 'family-b'],
      initialOutput: { status: 'error', error: '401 unauthorized' },
      fallbackProviderId: 'fallback' as ExecutionProviderId,
      hasStreamedOutput: () => false,
      invoke: async () => ({ status: 'success' }),
      onFailover: (toProviderId, details) => {
        seen.push(details);
        return 'from-provider' as ExecutionProviderId;
      },
      log: () => {},
    });

    expect(output.status).toBe('success');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      fromModel: 'family-a',
      toModel: 'family-b',
      reason: '401 unauthorized',
    });
  });

  it('does not call onFailover when the first attempt succeeds', async () => {
    let called = 0;
    await runFamilyFailoverLoop({
      candidates: ['family-a', 'family-b'],
      initialOutput: { status: 'success' },
      fallbackProviderId: 'fallback' as ExecutionProviderId,
      hasStreamedOutput: () => false,
      invoke: async () => ({ status: 'success' }),
      onFailover: (toProviderId) => {
        called += 1;
        return toProviderId;
      },
      log: () => {},
    });
    expect(called).toBe(0);
  });
});
