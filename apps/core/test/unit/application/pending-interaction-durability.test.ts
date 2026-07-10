import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindPendingPermissionInteractionMessage,
  configurePendingInteractionDurability,
  findDurablePermissionInteractionByPromptMessage,
  findDurablePermissionInteractionByRequestId,
  isActiveRunLeaseForInteraction,
  resolveDurableQuestionInteractionByRequestId,
  resolvePendingInteractionRecord,
  recordRunScopedTransientGrant,
} from '@core/application/interactions/pending-interaction-durability.js';
import { finishDurablePermissionInteraction } from '@core/application/interactions/durable-interaction-handler.js';

describe('pending interaction durability', () => {
  afterEach(() => {
    configurePendingInteractionDurability(null);
  });

  it('does not rebind a transient grant to a recovered lease', async () => {
    const repository = {
      getActiveRunLease: vi.fn(async () => ({
        runId: 'run-1',
        jobId: 'job-1',
        workerInstanceId: 'worker-2',
        leaseToken: 'new-token',
        fencingVersion: 2,
        status: 'active',
        claimedAt: '2026-06-10T00:01:00.000Z',
        expiresAt: '2026-06-10T00:06:00.000Z',
        heartbeatAt: '2026-06-10T00:01:00.000Z',
      })),
      createTransientGrant: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await recordRunScopedTransientGrant({
      runId: 'run-1',
      runLeaseToken: 'old-token',
      runLeaseFencingVersion: 1,
      grant: { toolName: 'Bash', mode: 'allow_once' },
    });

    expect(repository.createTransientGrant).not.toHaveBeenCalled();
  });

  it('rejects interaction lease checks for a recovered lease', async () => {
    const repository = {
      getActiveRunLease: vi.fn(async () => ({
        runId: 'run-1',
        jobId: 'job-1',
        workerInstanceId: 'worker-2',
        leaseToken: 'new-token',
        fencingVersion: 2,
        status: 'active',
        claimedAt: '2026-06-10T00:01:00.000Z',
        expiresAt: '2026-06-10T00:06:00.000Z',
        heartbeatAt: '2026-06-10T00:01:00.000Z',
      })),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      isActiveRunLeaseForInteraction({
        runId: 'run-1',
        runLeaseToken: 'old-token',
        runLeaseFencingVersion: 1,
      }),
    ).resolves.toBe(false);
  });

  it('binds a permission prompt to the exact provider message id', async () => {
    const pending = {
      id: 'pending-permission-1',
      appId: 'default',
      runId: 'run-1',
      kind: 'permission',
      status: 'pending',
      payload: {
        requestId: 'perm-1',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
      },
      callbackRoute: null,
      idempotencyKey: 'permission:main_agent:perm-1',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-23T00:00:00.000Z',
      expiresAt: '2026-06-24T00:00:00.000Z',
      resolvedAt: null,
    };
    const repository = {
      listPendingInteractions: vi.fn(async () => [pending]),
      updatePendingInteractionPayload: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      bindPendingPermissionInteractionMessage({
        sourceAgentFolder: 'main_agent',
        requestId: 'perm-1',
        externalMessageId: '1710000000.400500',
        provider: 'slack',
        conversationId: 'C123',
        threadId: '1710000000.111111',
      }),
    ).resolves.toBe(true);

    expect(repository.updatePendingInteractionPayload).toHaveBeenCalledWith({
      idempotencyKey: 'permission:main_agent:perm-1',
      payload: {
        requestId: 'perm-1',
        sourceAgentFolder: 'main_agent',
        toolName: 'Bash',
        externalPromptMessageId: '1710000000.400500',
        externalPromptProvider: 'slack',
        externalPromptConversationId: 'C123',
        externalPromptThreadId: '1710000000.111111',
      },
    });
  });

  it('binds permission prompt messages in the request app scope', async () => {
    const repository = {
      listPendingInteractions: vi.fn(async () => [
        {
          id: 'pending-permission-2',
          appId: 'app:two',
          kind: 'permission',
          status: 'pending',
          payload: { requestId: 'perm-2', sourceAgentFolder: 'main_agent' },
          callbackRoute: null,
          idempotencyKey: 'permission:main_agent:perm-2',
          approverRef: null,
          resolution: null,
          createdAt: '2026-06-23T00:00:00.000Z',
          expiresAt: '2026-06-24T00:00:00.000Z',
          resolvedAt: null,
        },
      ]),
      updatePendingInteractionPayload: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      bindPendingPermissionInteractionMessage({
        sourceAgentFolder: 'main_agent',
        requestId: 'perm-2',
        appId: 'app:two',
        externalMessageId: 'message-2',
      }),
    ).resolves.toBe(true);

    expect(repository.listPendingInteractions).toHaveBeenCalledWith({
      appId: 'app:two',
    });
  });

  it('persists a redacted permission full-view payload with the prompt binding', async () => {
    const pending = {
      id: 'pending-permission-full-view',
      appId: 'default',
      kind: 'permission',
      status: 'pending',
      payload: {
        requestId: 'perm-full-view',
        sourceAgentFolder: 'main_agent',
        conversationId: 'sl:C123',
        decisionPolicy: 'same_channel',
      },
      callbackRoute: null,
      idempotencyKey: 'permission:main_agent:perm-full-view',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-23T00:00:00.000Z',
      expiresAt: '2026-06-24T00:00:00.000Z',
      resolvedAt: null,
    };
    let payload = pending.payload as Record<string, unknown>;
    const repository = {
      listPendingInteractions: vi.fn(async () => [{ ...pending, payload }]),
      updatePendingInteractionPayload: vi.fn(
        async (input: { payload: Record<string, unknown> }) => {
          payload = input.payload;
          return true;
        },
      ),
    };
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      bindPendingPermissionInteractionMessage({
        sourceAgentFolder: 'main_agent',
        requestId: 'perm-full-view',
        externalMessageId: '1710000000.400500',
        provider: 'slack',
        conversationId: 'C123',
        fullView: {
          label: 'View full command',
          title: 'Full command',
          filename: 'permission-command.txt',
          content: 'git status --short',
        },
      }),
    ).resolves.toBe(true);

    await expect(
      findDurablePermissionInteractionByRequestId({
        requestId: 'perm-full-view',
      }),
    ).resolves.toMatchObject({
      sourceAgentFolder: 'main_agent',
      targetJid: 'sl:C123',
      decisionPolicy: 'same_channel',
      fullView: {
        label: 'View full command',
        title: 'Full command',
        filename: 'permission-command.txt',
        content: 'git status --short',
      },
    });
  });

  it('finds a permission prompt only by exact provider message binding', async () => {
    const repository = {
      listPendingInteractions: vi.fn(async () => [
        {
          id: 'pending-permission-1',
          appId: 'default',
          runId: 'run-1',
          kind: 'permission',
          status: 'pending',
          payload: {
            requestId: 'perm-1',
            sourceAgentFolder: 'main_agent',
            conversationId: 'sl:C123',
            decisionPolicy: 'same_channel',
            externalPromptProvider: 'slack',
            externalPromptConversationId: 'C123',
            externalPromptMessageId: '1710000000.400500',
            externalPromptThreadId: '1710000000.111111',
          },
          callbackRoute: null,
          idempotencyKey: 'permission:main_agent:perm-1',
          approverRef: null,
          resolution: null,
          createdAt: '2026-06-23T00:00:00.000Z',
          expiresAt: '2026-06-24T00:00:00.000Z',
          resolvedAt: null,
        },
      ]),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      findDurablePermissionInteractionByPromptMessage({
        provider: 'slack',
        conversationId: 'C123',
        externalMessageId: '1710000000.400500',
        threadId: '1710000000.111111',
      }),
    ).resolves.toEqual({
      requestId: 'perm-1',
      sourceAgentFolder: 'main_agent',
      targetJid: 'sl:C123',
      decisionPolicy: 'same_channel',
    });

    await expect(
      findDurablePermissionInteractionByPromptMessage({
        provider: 'slack',
        conversationId: 'C999',
        externalMessageId: '1710000000.400500',
        threadId: '1710000000.111111',
      }),
    ).resolves.toBeNull();
  });

  it('returns false when the pending interaction row is not resolved', async () => {
    const repository = {
      resolvePendingInteraction: vi.fn(async () => false),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      resolvePendingInteractionRecord({
        kind: 'permission',
        sourceAgentFolder: 'main_agent',
        requestId: 'perm-missing',
        appId: 'app:test',
        runId: null,
        status: 'resolved',
        resolution: { approved: true },
        approverRef: 'owner',
      }),
    ).resolves.toBe(false);
  });

  it('does not create transient grants without the requesting lease identity', async () => {
    const repository = {
      getActiveRunLease: vi.fn(async () => ({
        runId: 'run-1',
        jobId: 'job-1',
        workerInstanceId: 'worker-1',
        leaseToken: 'lease-token',
        fencingVersion: 1,
        status: 'active',
        claimedAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        heartbeatAt: '2026-06-10T00:00:00.000Z',
      })),
      createTransientGrant: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await recordRunScopedTransientGrant({
      runId: 'run-1',
      grant: { toolName: 'Bash', mode: 'allow_once' },
    });

    expect(repository.createTransientGrant).not.toHaveBeenCalled();
  });

  it('binds a transient grant to the requesting active lease', async () => {
    const repository = {
      getActiveRunLease: vi.fn(async () => ({
        runId: 'run-1',
        jobId: 'job-1',
        workerInstanceId: 'worker-1',
        leaseToken: 'lease-token',
        fencingVersion: 1,
        status: 'active',
        claimedAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-10T00:05:00.000Z',
        heartbeatAt: '2026-06-10T00:00:00.000Z',
      })),
      createTransientGrant: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await recordRunScopedTransientGrant({
      appId: 'default',
      runId: 'run-1',
      runLeaseToken: 'lease-token',
      runLeaseFencingVersion: 1,
      grant: { toolName: 'Bash', mode: 'allow_once' },
    });

    expect(repository.createTransientGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        runId: 'run-1',
        leaseToken: 'lease-token',
        grant: { toolName: 'Bash', mode: 'allow_once' },
      }),
    );
  });

  it('records timed grants resolved synchronously by an inline prompt', async () => {
    const timedGrantExpiresAtMs = Date.parse('2099-01-01T00:05:00.000Z');
    const repository = {
      getActiveRunLease: vi.fn(async () => ({
        runId: 'run-inline',
        jobId: null,
        workerInstanceId: 'worker-inline',
        leaseToken: 'lease-inline',
        fencingVersion: 1,
        status: 'active',
        claimedAt: '2099-01-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:10:00.000Z',
        heartbeatAt: '2099-01-01T00:00:00.000Z',
      })),
      createTransientGrant: vi.fn(async () => true),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      finishDurablePermissionInteraction({
        request: {
          requestId: 'permission-inline',
          sourceAgentFolder: 'main_agent',
          appId: 'default',
          runId: 'run-inline',
          runLeaseToken: 'lease-inline',
          runLeaseFencingVersion: 1,
          targetJid: 'conversation:inline',
          toolName: 'AgentDelegation',
          displayName: 'AgentDelegation',
          description: 'Delegate work.',
          decisionOptions: ['allow_timed_grant', 'cancel'],
        },
        sourceAgentFolder: 'main_agent',
        decision: {
          approved: true,
          mode: 'allow_timed_grant',
          decisionClassification: 'user_temporary',
          timedGrantExpiresAtMs,
          decidedBy: 'owner',
        },
      }),
    ).resolves.toBe(true);

    expect(repository.createTransientGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        runId: 'run-inline',
        leaseToken: 'lease-inline',
        grant: {
          toolName: 'AgentDelegation',
          mode: 'allow_timed_grant',
          requestId: 'permission-inline',
        },
        expiresAt: '2099-01-01T00:05:00.000Z',
      }),
    );
  });

  it('resolves pending interactions when no live-turn backend is configured', async () => {
    const repository = {
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      resolvePendingInteractionRecord({
        kind: 'permission',
        sourceAgentFolder: 'agent-folder',
        requestId: 'req-1',
        runId: 'run-1',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
      }),
    ).resolves.toBe(true);

    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith({
      idempotencyKey: 'permission:agent-folder:req-1',
      status: 'resolved',
      resolution: { approved: true, mode: 'allow_once' },
      approverRef: 'user:approver',
    });
  });

  it('enqueues the durable command BEFORE resolving the pending row', async () => {
    // The order matters for the crash window: if the row flipped to resolved
    // first and the process died before the live-turn command persisted, the
    // runner would be blocked with no durable command to replay. Pinning the
    // order (command append → row resolve) is the whole point of the change.
    const order: string[] = [];
    const repository = {
      listPendingInteractions: vi.fn(async () => [
        {
          id: 'pending-1',
          appId: 'default',
          runId: 'run-1',
          kind: 'permission',
          status: 'pending',
          payload: {},
          callbackRoute: {
            ipcBaseDir: '/tmp/ipc',
            threadId: 'thread-1',
            responseKeyId: 'key-1',
            responseNonce: 'nonce-1',
          },
          idempotencyKey: 'permission:agent-folder:req-1',
          approverRef: null,
          resolution: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          expiresAt: '2026-06-11T00:00:00.000Z',
          resolvedAt: null,
        },
      ]),
      resolvePendingInteraction: vi.fn(async () => {
        order.push('resolve');
        return true;
      }),
    };
    const liveTurns = {
      findActiveLiveTurnByRunId: vi.fn(async () => ({ id: 'turn-1' })),
      appendLiveTurnCommand: vi.fn(async () => {
        order.push('append');
        return { outcome: 'appended', command: null };
      }),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
      liveTurns: liveTurns as never,
    });

    await expect(
      resolvePendingInteractionRecord({
        kind: 'permission',
        sourceAgentFolder: 'agent-folder',
        requestId: 'req-1',
        runId: 'run-1',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
      }),
    ).resolves.toBe(true);

    // The command was enqueued strictly before the row was resolved.
    expect(order).toEqual(['append', 'resolve']);
    expect(liveTurns.appendLiveTurnCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        liveTurnId: 'turn-1',
        commandType: 'interaction_resolved',
        idempotencyKey: 'interaction_resolved:permission:agent-folder:req-1',
        payload: expect.objectContaining({
          kind: 'permission',
          requestId: 'req-1',
          callbackRoute: expect.objectContaining({
            ipcBaseDir: '/tmp/ipc',
            responseKeyId: 'key-1',
          }),
        }),
      }),
    );
    expect(repository.resolvePendingInteraction).toHaveBeenCalledOnce();
  });

  it('treats a replayed durable command as delivered and still resolves (idempotent retry)', async () => {
    // Approver-retry / crash-window path: a second resolve attempt re-appends
    // the same `interaction_resolved:<key>` idempotency key, which the command
    // store replays (outcome 'replayed', not 'rejected'). The retry must still
    // succeed and flip the row resolved — no duplicate command, no stuck row.
    const repository = {
      listPendingInteractions: vi.fn(async () => [
        {
          id: 'pending-1',
          appId: 'default',
          runId: 'run-1',
          kind: 'permission',
          status: 'pending',
          payload: {},
          callbackRoute: { ipcBaseDir: '/tmp/ipc' },
          idempotencyKey: 'permission:agent-folder:req-1',
          approverRef: null,
          resolution: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          expiresAt: '2026-06-11T00:00:00.000Z',
          resolvedAt: null,
        },
      ]),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    const liveTurns = {
      findActiveLiveTurnByRunId: vi.fn(async () => ({ id: 'turn-1' })),
      appendLiveTurnCommand: vi.fn(async () => ({
        outcome: 'replayed',
        command: null,
      })),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
      liveTurns: liveTurns as never,
    });

    await expect(
      resolvePendingInteractionRecord({
        kind: 'permission',
        sourceAgentFolder: 'agent-folder',
        requestId: 'req-1',
        runId: 'run-1',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
      }),
    ).resolves.toBe(true);

    expect(liveTurns.appendLiveTurnCommand).toHaveBeenCalledOnce();
    expect(repository.resolvePendingInteraction).toHaveBeenCalledOnce();
  });

  it('leaves pending interactions unresolved when live-turn delivery is rejected', async () => {
    const repository = {
      listPendingInteractions: vi.fn(async () => [
        {
          id: 'pending-1',
          appId: 'default',
          runId: 'run-1',
          kind: 'permission',
          status: 'pending',
          payload: {},
          callbackRoute: { ipcBaseDir: '/tmp/ipc' },
          idempotencyKey: 'permission:agent-folder:req-1',
          approverRef: null,
          resolution: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          expiresAt: '2026-06-11T00:00:00.000Z',
          resolvedAt: null,
        },
      ]),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    const liveTurns = {
      findActiveLiveTurnByRunId: vi.fn(async () => ({ id: 'turn-1' })),
      appendLiveTurnCommand: vi.fn(async () => ({
        outcome: 'rejected',
        command: null,
      })),
    };
    const warn = vi.fn();
    configurePendingInteractionDurability({
      repository: repository as never,
      liveTurns: liveTurns as never,
      warn,
    });

    await expect(
      resolvePendingInteractionRecord({
        kind: 'permission',
        sourceAgentFolder: 'agent-folder',
        requestId: 'req-1',
        runId: 'run-1',
        status: 'resolved',
        resolution: { approved: true, mode: 'allow_once' },
        approverRef: 'user:approver',
      }),
    ).resolves.toBe(false);

    expect(liveTurns.appendLiveTurnCommand).toHaveBeenCalledOnce();
    // The row is NOT resolved: it stays pending and re-resolvable. No
    // compensating "restore to pending" step is needed because the resolve
    // never happened (command-before-resolve order).
    expect(repository.resolvePendingInteraction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', requestId: 'req-1' }),
      'Failed to enqueue interaction resolution to the owning live turn',
    );
  });

  it('finds durable permission source agent from the request snapshot', async () => {
    const repository = {
      listPendingInteractions: vi.fn(async () => [
        {
          id: 'pending-1',
          appId: 'default',
          runId: 'run-1',
          kind: 'permission',
          status: 'pending',
          payload: {
            requestId: 'req-1',
            conversationId: 'chat-1',
            decisionPolicy: 'approval_required',
            request: { sourceAgentFolder: 'agent-folder' },
          },
          callbackRoute: { targetJid: 'chat-1' },
          idempotencyKey: 'permission:agent-folder:req-1',
          approverRef: null,
          resolution: null,
          createdAt: '2026-06-10T00:00:00.000Z',
          expiresAt: '2026-06-11T00:00:00.000Z',
          resolvedAt: null,
        },
      ]),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      findDurablePermissionInteractionByRequestId({
        requestId: 'req-1',
      }),
    ).resolves.toEqual({
      sourceAgentFolder: 'agent-folder',
      targetJid: 'chat-1',
      threadId: null,
      decisionPolicy: 'approval_required',
    });
  });

  it('persists durable multi-select question choices before final resolution', async () => {
    let payload: Record<string, unknown> = {
      requestId: 'question-1',
      sourceAgentFolder: 'agent-folder',
      request: {
        questions: [
          {
            question: 'Choose tools',
            header: 'Choose tools',
            multiSelect: true,
            options: [
              { label: 'Browser', description: '' },
              { label: 'Slack', description: '' },
            ],
          },
        ],
      },
    };
    const pending = {
      id: 'pending-question-1',
      appId: 'default',
      runId: 'run-1',
      kind: 'question',
      status: 'pending',
      get payload() {
        return payload;
      },
      callbackRoute: null,
      idempotencyKey: 'question:agent-folder:question-1',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2026-06-11T00:00:00.000Z',
      resolvedAt: null,
    };
    const repository = {
      listPendingInteractions: vi.fn(async () => [pending]),
      updatePendingInteractionPayload: vi.fn(async (input) => {
        payload = input.payload;
        return true;
      }),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      resolveDurableQuestionInteractionByRequestId({
        requestId: 'question-1',
        questionIndex: 0,
        optionIndex: 0,
      }),
    ).resolves.toBe(true);

    expect(repository.updatePendingInteractionPayload).toHaveBeenCalledWith({
      idempotencyKey: 'question:agent-folder:question-1',
      payload: expect.objectContaining({
        questionSelections: [{ questionIndex: 0, optionIndexes: [0] }],
      }),
    });

    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      resolveDurableQuestionInteractionByRequestId({
        requestId: 'question-1',
        questionIndex: 0,
        finalize: true,
        answeredBy: 'user:approver',
      }),
    ).resolves.toBe(true);

    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith({
      idempotencyKey: 'question:agent-folder:question-1',
      status: 'resolved',
      resolution: { answers: { 'Choose tools': ['Browser'] } },
      approverRef: 'user:approver',
    });
  });
});
