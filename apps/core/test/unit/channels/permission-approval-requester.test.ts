import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
import { DEFAULT_PERMISSION_BATCH_WINDOW_MS } from '@core/channels/permission-batch-coalescer.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '@core/domain/types.js';

describe('createPermissionApprovalRequester cancellation retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('catches a throwing channel handler and leaves retry ownership to the durable directory', async () => {
    vi.useFakeTimers();
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    let resolveDecision!: (decision: PermissionApprovalDecision) => void;
    const cancellationFailure = new Error(
      'permission cancellation unavailable',
    );
    const cancelPendingPermission = vi
      .fn()
      .mockRejectedValue(cancellationFailure);
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

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: cancellationFailure,
          targetJid: 'tg:team',
          requestId: request.requestId,
          message: 'Target channel permission cancellation failed',
        }),
      );
      await vi.advanceTimersByTimeAsync(1_500);
      expect(cancelPendingPermission).toHaveBeenCalledOnce();
      resolveDecision({
        approved: true,
        mode: 'allow_once',
        decidedBy: 'approver',
      });
      await expect(decision).resolves.toMatchObject({
        approved: false,
        mode: 'cancel',
      });
      await Promise.resolve();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });

  it.each([
    ['retryable', 'queued'],
    ['not_found', 'queued'],
    ['settled', 'settled'],
    ['already_decided', 'settled'],
  ] as const)(
    'maps channel result %s to %s without starting a local retry',
    async (channelResult, cancellationResult) => {
      vi.useFakeTimers();
      let resolveDecision!: (decision: PermissionApprovalDecision) => void;
      const cancelPendingPermission = vi.fn(async () => channelResult);
      const requester = createPermissionApprovalRequester({
        findBoundChannel: () => ({}),
        asPermissionApprovalSurface: () => ({
          requestPermissionApproval: async (
            _jid,
            _request,
            onPromptDelivered,
          ) => {
            onPromptDelivered?.('permission-prompt');
            return new Promise<PermissionApprovalDecision>((resolve) => {
              resolveDecision = resolve;
            });
          },
          cancelPendingPermission,
        }),
        interactionLifecycle: { logger: { error: vi.fn() } },
      });
      const cancellation = {
        requestId: `permission-${channelResult}`,
        appId: 'default',
        sourceAgentFolder: 'main_agent',
        reason: 'Permission cancelled.',
      };
      const decision = requester({
        ...cancellation,
        targetJid: 'tg:team',
        toolName: 'Bash',
      });

      await expect(requester.cancel(cancellation)).resolves.toBe(
        cancellationResult,
      );
      await vi.advanceTimersByTimeAsync(1_500);
      expect(cancelPendingPermission).toHaveBeenCalledOnce();
      resolveDecision({
        approved: true,
        mode: 'allow_once',
        decidedBy: 'approver',
      });
      await decision;
    },
  );

  it('preserves a retryable member cancellation through batch fan-out', async () => {
    vi.useFakeTimers();
    let resolveBatchDecision!: (decision: PermissionApprovalDecision) => void;
    const requestPermissionApproval = vi.fn(
      async (_jid, _request, onPromptDelivered) => {
        onPromptDelivered?.('permission-batch-prompt');
        return new Promise<PermissionApprovalDecision>((resolve) => {
          resolveBatchDecision = resolve;
        });
      },
    );
    const cancelPendingPermission = vi.fn(async () => 'retryable' as const);
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval,
        cancelPendingPermission,
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const first: PermissionApprovalRequest = {
      requestId: 'permission-batch-member-1',
      appId: 'default',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:team',
      threadId: 'thread-1',
      runId: 'run-1',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
    };
    const second: PermissionApprovalRequest = {
      ...first,
      requestId: 'permission-batch-member-2',
      toolInput: { command: 'git diff' },
    };
    const decisions = [requester(first), requester(second)];

    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);
    await expect(
      requester.cancel({
        requestId: second.requestId,
        appId: second.appId,
        sourceAgentFolder: second.sourceAgentFolder,
        reason: 'Permission request cancelled.',
      }),
    ).resolves.toBe('queued');

    resolveBatchDecision({
      approved: true,
      mode: 'allow_persistent_rule',
      decidedBy: 'approver',
      updatedPermissions: [
        {
          type: 'add_permission',
          rule: 'RunCommand(git:*)',
          behavior: 'allow',
          destination: 'agent',
        },
      ],
    });

    await expect(Promise.all(decisions)).resolves.toEqual([
      expect.objectContaining({ approved: true, mode: 'allow_once' }),
      expect.objectContaining({
        approved: false,
        mode: 'cancel',
        reason: 'Permission request cancelled.',
      }),
    ]);
    expect((await decisions[1]).updatedPermissions).toBeUndefined();

    await vi.advanceTimersByTimeAsync(250);
    expect(cancelPendingPermission).toHaveBeenCalledOnce();
  });

  it('applies a retryable cancellation if a single prompt resolves before its retry', async () => {
    vi.useFakeTimers();
    let resolveDecision!: (decision: PermissionApprovalDecision) => void;
    const cancelPendingPermission = vi.fn(async () => 'retryable' as const);
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: async (
          _jid,
          _request,
          onPromptDelivered,
        ) => {
          onPromptDelivered?.('permission-prompt');
          return new Promise<PermissionApprovalDecision>((resolve) => {
            resolveDecision = resolve;
          });
        },
        cancelPendingPermission,
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const request: PermissionApprovalRequest = {
      requestId: 'permission-single-retryable-cancel',
      appId: 'default',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:team',
      toolName: 'Bash',
    };
    const decision = requester(request);

    await expect(
      requester.cancel({
        requestId: request.requestId,
        appId: request.appId,
        sourceAgentFolder: request.sourceAgentFolder,
        reason: 'Permission request cancelled.',
      }),
    ).resolves.toBe('queued');

    resolveDecision({
      approved: true,
      mode: 'allow_persistent_rule',
      updatedPermissions: [
        {
          type: 'add_permission',
          rule: 'RunCommand(git:*)',
          behavior: 'allow',
          destination: 'agent',
        },
      ],
    });

    await expect(decision).resolves.toEqual(
      expect.objectContaining({
        approved: false,
        mode: 'cancel',
        reason: 'Permission request cancelled.',
      }),
    );
    expect((await decision).updatedPermissions).toBeUndefined();

    await vi.advanceTimersByTimeAsync(250);
    expect(cancelPendingPermission).toHaveBeenCalledOnce();
  });
});
