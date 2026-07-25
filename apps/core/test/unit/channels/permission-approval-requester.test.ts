import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '@core/domain/types.js';

describe('createPermissionApprovalRequester cancellation retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('catches a rejected cancellation retry, logs it, and reschedules without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    let resolveDecision!: (decision: PermissionApprovalDecision) => void;
    const cancellationFailure = new Error(
      'permission cancellation unavailable',
    );
    const cancelPendingPermission = vi
      .fn()
      .mockResolvedValueOnce('retryable')
      .mockRejectedValueOnce(cancellationFailure)
      .mockImplementationOnce(async () => {
        resolveDecision({
          approved: false,
          mode: 'cancel',
          decidedBy: 'runtime',
        });
        return 'settled' as const;
      });
    const logger = { error: vi.fn() };
    const requestPermissionApproval = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: vi.fn(
          async (_jid, _request, onPromptDelivered) => {
            onPromptDelivered?.('permission-prompt-retry');
            return new Promise<PermissionApprovalDecision>((resolve) => {
              resolveDecision = resolve;
            });
          },
        ),
        cancelPendingPermission,
      }),
      interactionLifecycle: { logger },
    });
    const request: PermissionApprovalRequest = {
      requestId: 'permission-cancel-retry',
      appId: 'default',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:team',
      toolName: 'Bash',
    };

    try {
      const decision = requestPermissionApproval(request);
      await expect(
        requestPermissionApproval.cancel({
          requestId: request.requestId,
          appId: request.appId,
          sourceAgentFolder: request.sourceAgentFolder,
          reason: 'Permission cancelled.',
        }),
      ).resolves.toBe('queued');

      await vi.advanceTimersByTimeAsync(250);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: cancellationFailure,
          targetJid: 'tg:team',
          requestId: request.requestId,
          message: 'Target channel permission cancellation failed',
        }),
      );
      expect(cancelPendingPermission).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(250);
      await expect(decision).resolves.toMatchObject({
        approved: false,
        mode: 'cancel',
      });
      expect(cancelPendingPermission).toHaveBeenCalledTimes(3);
      await Promise.resolve();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });
});
