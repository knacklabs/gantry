import { describe, expect, it, vi } from 'vitest';

import { runDurablePermissionInteraction } from '@core/application/interactions/durable-interaction-handler.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';

describe('durable permission interaction delivery failures', () => {
  it('leaves the durable row pending and skips decision side effects', async () => {
    const request: PermissionApprovalRequest = {
      requestId: 'permission-delivery-failed',
      appId: 'app:test' as never,
      sourceAgentFolder: 'main_agent',
      targetJid: 'sl:C123',
      toolName: 'Bash',
    };
    const record = vi.fn(async (input: { interactionId: string }) => ({
      id: input.interactionId,
    }));
    const resolve = vi.fn(async () => true);
    const afterDecision = vi.fn();

    await expect(
      runDurablePermissionInteraction({
        request,
        sourceAgentFolder: request.sourceAgentFolder,
        prompt: vi.fn(async () => ({
          kind: 'delivery_failure' as const,
          code: 'provider_failed' as const,
          retryable: false,
          delivered: 'unknown' as const,
          userMessage: 'Slack delivery outcome is unknown.',
        })),
        afterDecision,
        operations: {
          record,
          resolve,
          cancelPendingQuestionInteractionIfRunLeaseInactive: vi.fn(),
        } as never,
      }),
    ).resolves.toMatchObject({
      kind: 'delivery_failure',
      began: true,
      resolved: false,
      failure: {
        delivered: 'unknown',
        retryable: false,
      },
    });

    expect(record).toHaveBeenCalledOnce();
    expect(afterDecision).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
