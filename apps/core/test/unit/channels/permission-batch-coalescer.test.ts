import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PERMISSION_BATCH_WINDOW_MS,
  PENDING_PERMISSION_BATCH_WINDOW_MS,
  PermissionBatchCoalescer,
  createPermissionBatchRequest,
  decisionForPermissionInteraction,
  isDenyOrCancelDecision,
  permissionBatchButtonLabel,
  permissionBatchRows,
} from '@core/channels/permission-batch-coalescer.js';
import { createPermissionApprovalRequester } from '@core/channels/permission-approval-requester.js';
import { formatStructuredPermissionReceiptActionSummary } from '@core/channels/permission-receipt-action-summary.js';
import {
  configurePendingInteractionDurability,
  DurableInteractionPersistenceError,
} from '@core/application/interactions/pending-interaction-durability.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '@core/domain/types.js';

function request(
  requestId: string,
  overrides: Partial<PermissionApprovalRequest> = {},
): PermissionApprovalRequest {
  return {
    requestId,
    responseNonce: `nonce-${requestId}`,
    sourceAgentFolder: 'main_agent',
    targetJid: 'tg:team',
    threadId: 'thread-1',
    runId: 'run-1',
    decisionPolicy: 'same_channel',
    toolName: 'Bash',
    ...overrides,
  };
}

describe('PermissionBatchCoalescer', () => {
  afterEach(() => {
    vi.useRealTimers();
    configurePendingInteractionDurability(null);
  });

  it('keeps batch identity and Review-each semantics on provider clones', () => {
    const batch = createPermissionBatchRequest(
      [request('permission-1'), request('permission-2')],
      ['1. Read file', '2. Run command'],
    );
    const providerClone = { ...batch };

    expect(permissionBatchRows(providerClone)).toEqual([
      '1. Read file',
      '2. Run command',
    ]);
    expect(
      permissionBatchButtonLabel(providerClone, 'allow_persistent_rule'),
    ).toBe('Review each');
    expect(
      decisionForPermissionInteraction(
        providerClone,
        'allow_persistent_rule',
        'Ravi',
      ),
    ).toMatchObject({
      approved: true,
      mode: 'allow_persistent_rule',
      batchDecision: 'review_each',
    });
  });

  it('includes the exact member request set in the canonical batch id', () => {
    const first = createPermissionBatchRequest(
      [
        request('permission-1'),
        request('permission-2'),
        request('permission-3'),
      ],
      ['1. Read file', '2. Run command', '3. Write file'],
    );
    const reordered = createPermissionBatchRequest(
      [
        request('permission-1'),
        request('permission-3'),
        request('permission-2'),
      ],
      ['1. Read file', '2. Write file', '3. Run command'],
    );
    const differentMembers = createPermissionBatchRequest(
      [
        request('permission-1'),
        request('permission-2'),
        request('permission-4'),
      ],
      ['1. Read file', '2. Run command', '3. Fetch URL'],
    );

    expect(first.requestId).toBe(reordered.requestId);
    expect(differentMembers.requestId).not.toBe(first.requestId);
    expect(first.requestId).toMatch(/^batch:permission-1:3:[a-f0-9]{64}$/);
  });

  it.each([
    ['opening bracket', 'git [status'],
    ['Markdown link destination', 'git label](destination)'],
    ['backtick', 'git `status`'],
    ['asterisk', 'git *status*'],
    ['underscore', 'git status_short'],
    ['tilde', 'git ~status~'],
    ['angle bracket', 'git <status>'],
  ])('forces individual review for a %s', (_label, command) => {
    expect(
      formatStructuredPermissionReceiptActionSummary(
        request(`markup-${_label}`, { toolInput: { command } }),
      ).bulkEligible,
    ).toBe(false);
  });

  it('keeps a clean decision-bearing value eligible for bulk review', () => {
    expect(
      formatStructuredPermissionReceiptActionSummary(
        request('clean-scope', {
          toolInput: { command: 'git status --short' },
        }),
      ).bulkEligible,
    ).toBe(true);
  });

  it('offers Allow all only for exact unsanitized well-known tool input shapes', async () => {
    vi.useFakeTimers();
    const prompted: PermissionApprovalRequest[] = [];
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: async (_jid, approvalRequest) => {
          prompted.push(approvalRequest);
          return { approved: false, mode: 'cancel' };
        },
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });

    const decisions = [
      requester(
        request('generic-1', {
          runId: 'generic-run',
          toolName: 'mcp__ops__delete_target',
          toolInput: {
            command:
              'curl https://api.example.com/one -H "Authorization: bearer abcdefghijklmnopqrstuvwxyz123456"',
          },
        }),
      ),
      requester(
        request('generic-2', {
          runId: 'generic-run',
          toolName: 'mcp__ops__delete_target',
          toolInput: {
            command:
              'curl https://api.example.com/two -H "Authorization: bearer zyxwvutsrqponmlkjihgfedcba654321"',
          },
        }),
      ),
      requester(
        request('scoped-1', {
          runId: 'scoped-run',
          toolInput: { command: 'git status --short' },
        }),
      ),
      requester(
        request('scoped-2', {
          runId: 'scoped-run',
          toolName: 'Write',
          toolInput: { file_path: 'notes.md' },
        }),
      ),
      requester(
        request('url-1', {
          runId: 'url-run',
          toolName: 'WebFetch',
          toolInput: { url: 'https://example.com/one' },
        }),
      ),
      requester(
        request('url-2', {
          runId: 'url-run',
          toolName: 'WebFetch',
          toolInput: { url: 'https://example.com/two' },
        }),
      ),
      requester(
        request('pattern-1', {
          runId: 'pattern-run',
          toolName: 'Glob',
          toolInput: { pattern: '**/*.ts' },
        }),
      ),
      requester(
        request('pattern-2', {
          runId: 'pattern-run',
          toolName: 'Grep',
          toolInput: { pattern: 'permissionBatchCallbackId' },
        }),
      ),
      requester(
        request('display-1', {
          runId: 'display-run',
          displayName: 'Delete record (requested)',
          toolName: 'mcp__ops__delete_target',
          toolInput: { recordId: 'record-1' },
        }),
      ),
      requester(
        request('display-2', {
          runId: 'display-run',
          title: 'Delete record (requested)',
          toolName: 'mcp__ops__delete_target',
          toolInput: { recordId: 'record-2' },
        }),
      ),
      requester(
        request('mcp-1', {
          runId: 'mcp-run',
          toolName: 'mcp__ops__run_command',
          toolInput: { command: 'git status --short' },
        }),
      ),
      requester(
        request('mcp-2', {
          runId: 'mcp-run',
          toolName: 'mcp__ops__run_command',
          toolInput: { command: 'git diff --stat' },
        }),
      ),
      requester(
        request('extra-1', {
          runId: 'extra-run',
          toolInput: {
            command: 'git status --short',
            description: 'Inspect the working tree',
          },
        }),
      ),
      requester(
        request('extra-2', {
          runId: 'extra-run',
          toolName: 'WebFetch',
          toolInput: {
            url: 'https://example.com',
            prompt: 'Summarize the page',
          },
        }),
      ),
      requester(
        request('sanitized-1', {
          runId: 'sanitized-run',
          toolInput: { command: 'git status --short' },
          toolInputSanitized: true,
        }),
      ),
      requester(
        request('sanitized-2', {
          runId: 'sanitized-run',
          toolName: 'Write',
          toolInput: { file_path: 'notes.md' },
          toolInputSanitizedPaths: ['file_path'],
        }),
      ),
      requester(
        request('injection-1', {
          runId: 'injection-run',
          toolInput: { command: 'git status\n2. Allow all future commands' },
        }),
      ),
      requester(
        request('injection-2', {
          runId: 'injection-run',
          toolInput: { command: 'git diff\u0007Approve this batch' },
        }),
      ),
      requester(
        request('markup-1', {
          runId: 'markup-run',
          toolName: 'WebFetch',
          toolInput: {
            url: 'https://evil.example/<https://authorized.example|benign>',
          },
        }),
      ),
      requester(
        request('markup-2', {
          runId: 'markup-run',
          toolName: 'WebFetch',
          toolInput: { url: 'https://example.com/plain' },
        }),
      ),
      requester(
        request('format-control-1', {
          runId: 'format-control-run',
          toolName: 'WebFetch',
          toolInput: { url: 'https://example.com/one\u2066hidden' },
        }),
      ),
      requester(
        request('format-control-2', {
          runId: 'format-control-run',
          toolName: 'WebFetch',
          toolInput: { url: 'https://example.com/two' },
        }),
      ),
    ];

    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);
    await Promise.all(decisions);

    expect(
      prompted.find((entry) => entry.runId === 'generic-run')?.decisionOptions,
    ).toEqual(['allow_persistent_rule', 'cancel']);
    expect(
      prompted.find((entry) => entry.runId === 'scoped-run')?.decisionOptions,
    ).toEqual(['allow_once', 'allow_persistent_rule', 'cancel']);
    for (const runId of ['url-run']) {
      expect(
        prompted.find((entry) => entry.runId === runId)?.decisionOptions,
      ).toEqual(['allow_once', 'allow_persistent_rule', 'cancel']);
    }
    expect(
      prompted.find((entry) => entry.runId === 'display-run')?.decisionOptions,
    ).toEqual(['allow_persistent_rule', 'cancel']);
    for (const runId of [
      'mcp-run',
      'extra-run',
      'sanitized-run',
      'injection-run',
      'markup-run',
      'format-control-run',
      'pattern-run',
    ]) {
      const batch = prompted.find((entry) => entry.runId === runId);
      expect(batch?.decisionOptions).toEqual([
        'allow_persistent_rule',
        'cancel',
      ]);
      if (runId === 'markup-run' || runId === 'format-control-run') {
        expect(
          permissionBatchButtonLabel(batch!, 'allow_persistent_rule'),
        ).toBe('Review each');
      }
    }
  });

  it('keeps colliding request ids isolated by app and source agent', async () => {
    vi.useFakeTimers();
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: async (
          _jid,
          approvalRequest,
          onPromptDelivered,
        ) => {
          onPromptDelivered?.('prompt');
          return {
            approved: false,
            mode: 'cancel' as const,
            decidedBy: approvalRequest.sourceAgentFolder,
          };
        },
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const first = requester(
      request('permission-collision', {
        appId: 'app-one',
        sourceAgentFolder: 'agent-one',
      }),
    );
    const second = requester(
      request('permission-collision', {
        appId: 'app-two',
        sourceAgentFolder: 'agent-two',
      }),
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ decidedBy: 'agent-one' }),
      expect.objectContaining({ decidedBy: 'agent-two' }),
    ]);
  });

  it('shares one pending decision for the same full interaction scope', async () => {
    vi.useFakeTimers();
    const requestPermissionApproval = vi.fn(
      async (_jid, _request, onPromptDelivered) => {
        onPromptDelivered?.('prompt');
        return {
          approved: false,
          mode: 'cancel' as const,
          decidedBy: 'owner',
        };
      },
    );
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({ requestPermissionApproval }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const permissionRequest = request('permission-duplicate');
    const first = requester(permissionRequest);
    const replay = requester({ ...permissionRequest });

    expect(replay).toBe(first);
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    await expect(Promise.all([first, replay])).resolves.toEqual([
      expect.objectContaining({ decidedBy: 'owner' }),
      expect.objectContaining({ decidedBy: 'owner' }),
    ]);
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
  });

  it.each([
    ['Allow all', true, 'allow_once' as const],
    ['Deny all', false, 'cancel' as const],
  ])(
    'propagates the winning claim to every %s derived decision',
    async (_label, approved, mode) => {
      vi.useFakeTimers();
      const claim = {
        id: `claim-${mode}`,
        scope: {
          appId: 'default',
          sourceAgentFolder: 'main_agent',
          interactionId: 'batch:permission-1:2',
        },
      };
      const requester = createPermissionApprovalRequester({
        findBoundChannel: () => ({}),
        asPermissionApprovalSurface: () => ({
          requestPermissionApproval: async (
            _jid,
            _request,
            onPromptDelivered,
          ) => {
            onPromptDelivered?.('prompt');
            return {
              approved,
              mode,
              decidedBy: 'owner',
              permissionCallbackClaim: claim,
            };
          },
        }),
        interactionLifecycle: { logger: { error: vi.fn() } },
      });

      const decisions = [
        requester(request('permission-1')),
        requester(request('permission-2')),
      ];
      await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

      await expect(Promise.all(decisions)).resolves.toEqual([
        expect.objectContaining({ mode, permissionCallbackClaim: claim }),
        expect.objectContaining({ mode, permissionCallbackClaim: claim }),
      ]);
    },
  );

  it('leaves timeout authority with the provider instead of synthesizing an unclaimed decision', async () => {
    vi.useFakeTimers();
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: () =>
          new Promise<PermissionApprovalDecision>(() => undefined),
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    let settled = false;
    void requester(
      request('permission-provider-timeout', { runId: undefined }),
    ).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases the batch claim and completes unresolved requests when fan-out fails', async () => {
    vi.useFakeTimers();
    const releasePendingPermissionCallback = vi.fn(async () => 1);
    configurePendingInteractionDurability({
      repository: { releasePendingPermissionCallback } as never,
    });
    const claim = {
      id: 'claim-fan-out',
      scope: {
        appId: 'default',
        sourceAgentFolder: 'main_agent',
        interactionId: 'batch:permission-1:2',
      },
    };
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: async (
          _jid,
          _request,
          onPromptDelivered,
        ) => {
          onPromptDelivered?.('prompt');
          return {
            mode: 'allow_once',
            permissionCallbackClaim: claim,
            get approved(): boolean {
              throw new Error('simulated fan-out failure');
            },
          } as PermissionApprovalDecision;
        },
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const decisions = [
      requester(request('permission-1')),
      requester(request('permission-2')),
    ];

    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    await expect(Promise.all(decisions)).resolves.toEqual([
      { approved: false, reason: 'Permission batch dispatch failed' },
      { approved: false, reason: 'Permission batch dispatch failed' },
    ]);
    expect(releasePendingPermissionCallback).toHaveBeenCalledWith({ claim });
  });

  it('rejects every batched request when prompt persistence fails', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const persistenceError = new DurableInteractionPersistenceError(
      'permission prompt delivery was not persisted',
    );
    const dropPendingInteraction = vi.fn(
      (_kind: 'permission' | 'question', _request: PermissionApprovalRequest) =>
        events.push('drop'),
    );
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: async (
          _jid,
          _request,
          onPromptDelivered,
        ) => {
          onPromptDelivered?.('prompt');
          throw persistenceError;
        },
        dropPendingInteraction,
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const first = requester(request('permission-persistence-1'));
    void first.catch(() => events.push('reject'));
    const second = requester(request('permission-persistence-2'));
    void second.catch(() => events.push('reject'));
    const outcomes = Promise.allSettled([first, second]);

    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    expect(await outcomes).toEqual([
      { status: 'rejected', reason: persistenceError },
      { status: 'rejected', reason: persistenceError },
    ]);
    expect(dropPendingInteraction).toHaveBeenCalledWith(
      'permission',
      expect.objectContaining({
        permissionBatch: {
          requestIds: ['permission-persistence-1', 'permission-persistence-2'],
          rows: ['1. exact command access', '2. exact command access'],
        },
      }),
    );
    expect(events).toEqual(['drop', 'reject', 'reject']);
  });

  it('opens individual prompts only after Review each returns a claimed decision', async () => {
    vi.useFakeTimers();
    const first = request('permission-1');
    const second = request('permission-2');
    const events: string[] = [];
    const settlePendingPermissionCallback = vi.fn(async () => {
      events.push('settle');
      return 2;
    });
    configurePendingInteractionDurability({
      repository: { settlePendingPermissionCallback } as never,
    });
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({
        requestPermissionApproval: async (
          _jid,
          approvalRequest,
          onPromptDelivered,
        ) => {
          onPromptDelivered?.('prompt');
          events.push(
            approvalRequest.permissionBatch
              ? 'batch'
              : `individual:${approvalRequest.requestId}`,
          );
          if (approvalRequest.permissionBatch) {
            events.push('claim');
            return {
              approved: true,
              mode: 'allow_persistent_rule' as const,
              batchDecision: 'review_each' as const,
              decidedBy: 'first-approver',
              permissionCallbackClaim: {
                id: 'review-each-claim',
                scope: {
                  appId: 'default',
                  sourceAgentFolder: 'main_agent',
                  interactionId: approvalRequest.requestId,
                },
              },
            };
          }
          return { approved: false, mode: 'cancel' as const };
        },
      }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });

    const decisions = [requester(first), requester(second)];
    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);
    await expect(Promise.all(decisions)).resolves.toEqual([
      expect.objectContaining({ approved: false, mode: 'cancel' }),
      expect.objectContaining({ approved: false, mode: 'cancel' }),
    ]);

    expect(events).toEqual([
      'batch',
      'claim',
      'settle',
      'individual:permission-1',
      'individual:permission-2',
    ]);
  });

  it('releases a Review each claim when it cannot be settled before fan-out', async () => {
    vi.useFakeTimers();
    const claim = {
      id: 'review-each-failed-settle',
      scope: {
        appId: 'default',
        sourceAgentFolder: 'main_agent',
        interactionId: 'batch:permission-1:2',
      },
    };
    const releasePendingPermissionCallback = vi.fn(async () => 2);
    configurePendingInteractionDurability({
      repository: {
        settlePendingPermissionCallback: vi.fn(async () => 0),
        releasePendingPermissionCallback,
      } as never,
    });
    const requestPermissionApproval = vi.fn(
      async (_jid, _request, onPromptDelivered) => {
        onPromptDelivered?.('prompt');
        return {
          approved: true,
          mode: 'allow_persistent_rule' as const,
          batchDecision: 'review_each' as const,
          permissionCallbackClaim: claim,
        };
      },
    );
    const requester = createPermissionApprovalRequester({
      findBoundChannel: () => ({}),
      asPermissionApprovalSurface: () => ({ requestPermissionApproval }),
      interactionLifecycle: { logger: { error: vi.fn() } },
    });
    const decisions = [
      requester(request('permission-1')),
      requester(request('permission-2')),
    ];

    await vi.advanceTimersByTimeAsync(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    await expect(Promise.all(decisions)).resolves.toEqual([
      { approved: false, reason: 'Permission batch dispatch failed' },
      { approved: false, reason: 'Permission batch dispatch failed' },
    ]);
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(releasePendingPermissionCallback).toHaveBeenCalledWith({ claim });
  });

  it('groups matching requests that arrive within the 1500ms window', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const first = request('permission-1');
    const second = request('permission-2', { appId: 'default' });

    coalescer.enqueue(first);
    vi.advanceTimersByTime(DEFAULT_PERMISSION_BATCH_WINDOW_MS - 1);
    coalescer.enqueue(second);

    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);

    expect(flushed).toEqual([[first, second]]);
    expect(flushed[0]?.map((entry) => entry.responseNonce)).toEqual([
      'nonce-permission-1',
      'nonce-permission-2',
    ]);
    expect(coalescer.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces topic/thread requests for the same parent conversation', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const first = request('permission-1', { threadId: 'thread-a' });
    const second = request('permission-2', { threadId: 'thread-b' });

    coalescer.enqueue(first);
    coalescer.enqueue(second);
    vi.advanceTimersByTime(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    expect(flushed).toEqual([[first, second]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not coalesce requests with different approvalContextJid', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const first = request('permission-1', {
      approvalContextJid: 'tg:approval-a',
    });
    const second = request('permission-2', {
      approvalContextJid: 'tg:approval-b',
    });

    coalescer.enqueue(first);
    coalescer.enqueue(second);
    vi.advanceTimersByTime(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    expect(flushed).toEqual([[first], [second]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the 3s window while a prompt for the same conversation is pending', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      isPromptPending: () => true,
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const first = request('permission-pending');

    coalescer.enqueue(first);
    vi.advanceTimersByTime(PENDING_PERMISSION_BATCH_WINDOW_MS - 1);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(flushed).toEqual([[first]]);
  });

  it('separates requests with mismatched batch identity fields', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const base = request('base');
    const mismatches = [
      request('app', { appId: 'other-app' }),
      request('source', { sourceAgentFolder: 'other_agent' }),
      request('target', { targetJid: 'tg:other' }),
      request('run', { runId: 'run-2' }),
      request('policy', { decisionPolicy: 'control_allowlist' }),
      request('provider-account', { providerAccountId: 'telegram_other' }),
    ];

    coalescer.enqueue(base);
    for (const entry of mismatches) coalescer.enqueue(entry);
    vi.advanceTimersByTime(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    expect(
      flushed.map((batch) => batch.map((entry) => entry.requestId)),
    ).toEqual([
      ['base'],
      ['app'],
      ['source'],
      ['target'],
      ['run'],
      ['policy'],
      ['provider-account'],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes all pending batches and clears timers on deny or cancel decisions', () => {
    vi.useFakeTimers();
    const coalescer = new PermissionBatchCoalescer();
    const first = request('permission-1');
    const second = request('permission-2', { targetJid: 'tg:other' });

    coalescer.enqueue(first);
    coalescer.enqueue(second);

    const flushed = coalescer.flushOnDecision({
      approved: false,
      mode: 'cancel',
      reason: 'user cancelled',
    });

    expect(flushed.map((batch) => batch.requests)).toEqual([[first], [second]]);
    expect(flushed.every((batch) => batch.reason === 'deny_or_cancel')).toBe(
      true,
    );
    expect(coalescer.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps pending batches on allow decisions', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const first = request('permission-1');

    coalescer.enqueue(first);
    expect(
      coalescer.flushOnDecision({ approved: true, mode: 'allow_once' }),
    ).toEqual([]);
    expect(coalescer.size()).toBe(1);

    vi.advanceTimersByTime(DEFAULT_PERMISSION_BATCH_WINDOW_MS);
    expect(flushed).toEqual([[first]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies deny and cancel decisions as terminal batch flush semantics', () => {
    const decisions: PermissionApprovalDecision[] = [
      { approved: false, reason: 'deny' },
      { approved: false, mode: 'cancel' },
      { approved: true, mode: 'cancel' },
    ];

    expect(decisions.map(isDenyOrCancelDecision)).toEqual([true, true, true]);
    expect(isDenyOrCancelDecision({ approved: true, mode: 'allow_once' })).toBe(
      false,
    );
  });
});
