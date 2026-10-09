import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
import type {
  PermissionApprovalRequest,
  PermissionApprovalResult,
} from '@core/domain/types.js';

describe('createPermissionApprovalRequester cancellation retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('catches a throwing channel handler and leaves retry ownership to the durable directory', async () => {
    vi.useFakeTimers();
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);
    let resolveDecision!: (result: PermissionApprovalResult) => void;
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
            return new Promise<PermissionApprovalResult>((resolve) => {
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
        kind: 'decision',
        decision: {
          approved: true,
          mode: 'allow_once',
          decidedBy: 'approver',
        },
      });
      await expect(decision).resolves.toMatchObject({
        kind: 'decision',
        decision: { approved: false, mode: 'cancel' },
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
      let resolveDecision!: (result: PermissionApprovalResult) => void;
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
            return new Promise<PermissionApprovalResult>((resolve) => {
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
        kind: 'decision',
        decision: {
          approved: true,
          mode: 'allow_once',
          decidedBy: 'approver',
        },
      });
      await decision;
    },
  );

  it('reports run-scoped prompt delivery only to the first coalesced caller', async () => {
    vi.useFakeTimers();
    const requestPermissionApproval = vi.fn(
      async (_jid, _request, onPromptDelivered) => {
        onPromptDelivered?.('permission-prompt');
        return {
          kind: 'decision' as const,
          decision: {
            approved: false,
            mode: 'cancel' as const,
            decidedBy: 'owner',
          },
        };
      },
    );
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({ requestPermissionApproval }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const request: PermissionApprovalRequest = {
      requestId: 'permission-run-scoped-delivery',
      appId: 'default',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:team',
      runId: 'run-1',
      toolName: 'Bash',
    };
    const firstDelivered = vi.fn();
    const replayDelivered = vi.fn();

    const first = requester(request, firstDelivered);
    const replay = requester({ ...request }, replayDelivered);
    expect(replay).toBe(first);

    await expect(Promise.all([first, replay])).resolves.toHaveLength(2);

    expect(firstDelivered).toHaveBeenCalledOnce();
    expect(firstDelivered).toHaveBeenCalledWith('permission-prompt');
    expect(replayDelivered).not.toHaveBeenCalled();
  });

  it('applies a retryable cancellation if a single prompt resolves before its retry', async () => {
    vi.useFakeTimers();
    let resolveDecision!: (result: PermissionApprovalResult) => void;
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
          return new Promise<PermissionApprovalResult>((resolve) => {
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
      kind: 'decision',
      decision: {
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
      },
    });

    await expect(decision).resolves.toEqual(
      expect.objectContaining({
        kind: 'decision',
        decision: expect.objectContaining({
          approved: false,
          mode: 'cancel',
          reason: 'Permission request cancelled.',
        }),
      }),
    );
    expect(
      (await decision).kind === 'decision'
        ? (await decision).decision.updatedPermissions
        : undefined,
    ).toBeUndefined();

    await vi.advanceTimersByTimeAsync(250);
    expect(cancelPendingPermission).toHaveBeenCalledOnce();
  });

  it('returns target_missing without inventing a denial decision', async () => {
    const requester = createPermissionApprovalRequester({
      findBoundChannel: vi.fn(),
      asPermissionApprovalSurface: vi.fn(),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });

    await expect(
      requester({
        requestId: 'permission-target-missing',
        appId: 'default',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
      }),
    ).resolves.toEqual({
      kind: 'delivery_failure',
      code: 'target_missing',
      retryable: true,
      delivered: 'no',
      userMessage: 'Permission approval target is missing',
    });
  });

  it('delivers simultaneous asks as separate prompts and answers each one independently', async () => {
    const answers = new Map<
      string,
      (result: PermissionApprovalResult) => void
    >();
    const prompted: PermissionApprovalRequest[] = [];
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: async (_jid, request) => {
          prompted.push(request);
          return new Promise<PermissionApprovalResult>((resolve) => {
            answers.set(request.requestId, resolve);
          });
        },
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const first: PermissionApprovalRequest = {
      requestId: 'permission-simultaneous-1',
      appId: 'default',
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:team',
      runId: 'run-1',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
    };
    const second: PermissionApprovalRequest = {
      ...first,
      requestId: 'permission-simultaneous-2',
      toolInput: { command: 'git diff' },
    };

    const firstDecision = requester(first);
    const secondDecision = requester(second);
    await vi.waitFor(() => expect(prompted).toHaveLength(2));

    expect(prompted).toEqual([first, second]);
    answers.get(second.requestId)!({
      kind: 'decision',
      decision: { approved: false, mode: 'cancel', decidedBy: 'owner' },
    });
    await expect(secondDecision).resolves.toMatchObject({
      decision: { approved: false, mode: 'cancel' },
    });
    answers.get(first.requestId)!({
      kind: 'decision',
      decision: { approved: true, mode: 'allow_once', decidedBy: 'owner' },
    });
    await expect(firstDecision).resolves.toMatchObject({
      decision: { approved: true, mode: 'allow_once' },
    });
  });
});
