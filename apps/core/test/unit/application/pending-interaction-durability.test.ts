import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindPendingPermissionInteractionMessage,
  claimPermissionInteractionCallback,
  configurePendingInteractionDurability,
  findDurablePermissionInteractionByPromptMessage,
  findDurablePermissionInteractionByRequestId,
  recordDurableQuestionAnswerProgress,
  recoverDurablePermissionDecision,
  isActiveRunLeaseForInteraction,
  releasePermissionInteractionCallback,
  resolveDurablePermissionInteractionByRequestId,
  resolveDurableQuestionInteractionByRequestId,
  resolvePendingInteractionRecord,
  resolvePendingInteractionRecordOutcome,
  recordRunScopedTransientGrant,
  replayPersistedPermissionDecisionForRequest,
} from '@core/application/interactions/pending-interaction-durability.js';
import { configurePendingInteractionPermissionCallbacks } from '@core/application/interactions/pending-interaction-permission-callback.js';
import {
  beginDurableQuestionInteraction,
  finishDurablePermissionInteraction,
  finishDurableQuestionInteraction,
  runDurableQuestionInteraction,
} from '@core/application/interactions/durable-interaction-handler.js';

function permissionRow(input: {
  id: string;
  agent: string;
  requestId: string;
  alias?: string;
  batchId?: string;
}) {
  return {
    id: input.id,
    appId: 'default',
    runId: 'run-1',
    sourceAgentFolder: input.agent,
    requestId: input.requestId,
    runLeaseToken: null,
    runLeaseFencingVersion: null,
    envelopeId: null,
    memberIndex: null,
    kind: 'permission',
    status: 'pending',
    payload: {
      requestId: input.requestId,
      sourceAgentFolder: input.agent,
      targetJid: 'sl:C123',
      toolName: 'Bash',
      request: {
        requestId: input.requestId,
        sourceAgentFolder: input.agent,
        targetJid: 'sl:C123',
        toolName: 'Bash',
        decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
        suggestions: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Bash', ruleContent: 'Bash(npm test)' }],
          },
        ],
      },
    } as Record<string, unknown>,
    callbackRoute: null,
    idempotencyKey: `default:permission:${input.agent}:${input.requestId}`,
    approverRef: null,
    resolution: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2099-07-17T00:00:00.000Z',
    resolvedAt: null,
    promptFixture: {
      interactionId: input.batchId ?? input.requestId,
      providerAliases: input.alias ? [input.alias] : [],
    },
  } as any;
}

function questionRecoveryEnvelope(request: any, targetJid: string | null) {
  return {
    version: 1,
    targetJid,
    threadId: request.threadId ?? null,
    request,
    selections: [],
    completedQuestionIndexes: [],
  };
}

function pendingQuestionRow(request: any) {
  return {
    id: `pending-${request.requestId}`,
    appId: request.appId || 'default',
    runId: request.runId ?? null,
    sourceAgentFolder: request.sourceAgentFolder,
    requestId: request.requestId,
    runLeaseToken: request.runLeaseToken ?? null,
    runLeaseFencingVersion: request.runLeaseFencingVersion ?? null,
    envelopeId: null,
    memberIndex: null,
    kind: 'question',
    status: 'pending',
    payload: {
      requestId: request.requestId,
      sourceAgentFolder: request.sourceAgentFolder,
      request,
      questionRecoveryEnvelope: questionRecoveryEnvelope(
        request,
        request.targetJid ?? null,
      ),
    } as Record<string, unknown>,
    callbackRoute: null,
    idempotencyKey: `test-${request.appId || 'default'}:question:${request.sourceAgentFolder}:${request.requestId}`,
    approverRef: null,
    resolution: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:00.000Z',
    resolvedAt: null,
  } as any;
}

function pendingInteractionLookups(rows: any[]) {
  return {
    listPendingInteractions: vi.fn(
      async ({ appId, runId }: { appId: string; runId?: string | null }) =>
        rows.filter(
          (row) =>
            row.appId === appId &&
            row.status === 'pending' &&
            (runId === undefined || row.runId === runId),
        ),
    ),
    findPendingInteractionByRequest: vi.fn(
      async ({ appId, kind, sourceAgentFolder, requestId }: any) =>
        rows.find(
          (row) =>
            row.appId === appId &&
            row.kind === kind &&
            row.status === 'pending' &&
            (row.requestId ?? row.payload?.requestId) === requestId &&
            (!sourceAgentFolder ||
              (row.sourceAgentFolder ?? row.payload?.sourceAgentFolder) ===
                sourceAgentFolder),
        ) ?? null,
    ),
    findPendingInteractionByIdempotencyKey: vi.fn(
      async ({ appId, idempotencyKey, runId }: any) =>
        rows.find(
          (row) =>
            row.appId === appId &&
            row.status === 'pending' &&
            row.idempotencyKey === idempotencyKey &&
            (runId === undefined || row.runId === runId),
        ) ?? null,
    ),
  };
}

function payloadUpdater(rows: any[]) {
  return vi.fn(
    async (input: {
      idempotencyKey: string;
      approverRef?: string | null;
      update: (
        payload: Record<string, unknown>,
      ) => Record<string, unknown> | null;
    }) => {
      const row = rows.find(
        (candidate) => candidate.idempotencyKey === input.idempotencyKey,
      );
      if (!row) return false;
      await Promise.resolve();
      const next = input.update(row.payload);
      if (!next) return false;
      row.payload = next;
      if (input.approverRef !== undefined) {
        row.approverRef = input.approverRef;
      }
      return true;
    },
  );
}

function permissionPromptRow(input: {
  id: string;
  agent: string;
  requestId: string;
  messageId: string;
  payload?: Record<string, unknown>;
  interactionId?: string;
  providerAliases?: string[];
  claim?: Record<string, unknown> | null;
  settlementState?: 'open' | 'claimed' | 'settled';
}) {
  const payload = {
    requestId: input.requestId,
    sourceAgentFolder: input.agent,
    targetJid: 'sl:C123',
    externalPromptProvider: 'slack',
    externalPromptConversationId: 'C123',
    externalPromptMessageId: input.messageId,
    externalPromptThreadId: 'thread-1',
    ...input.payload,
  } as Record<string, unknown>;
  const request = (payload.request as any) ?? {
    requestId: input.requestId,
    sourceAgentFolder: input.agent,
    targetJid: payload.targetJid,
    threadId: payload.threadId,
    toolName: 'Bash',
  };
  payload.request = request;
  return {
    id: input.id,
    appId: 'default',
    runId: 'run-1',
    sourceAgentFolder: input.agent,
    requestId: input.requestId,
    runLeaseToken: null,
    runLeaseFencingVersion: null,
    envelopeId: null,
    memberIndex: null,
    kind: 'permission',
    status: 'pending',
    payload,
    callbackRoute: null,
    idempotencyKey: `default:permission:${input.agent}:${input.requestId}`,
    approverRef: null,
    resolution: null,
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-17T00:00:00.000Z',
    resolvedAt: null,
    promptFixture: {
      interactionId: input.interactionId ?? input.requestId,
      providerAliases: input.providerAliases ?? [],
      externalPromptProvider: payload.externalPromptProvider,
      externalPromptConversationId: payload.externalPromptConversationId,
      externalPromptMessageId: payload.externalPromptMessageId,
      externalPromptThreadId: payload.externalPromptThreadId,
      claim: input.claim ?? null,
      settlementState:
        input.settlementState ?? (input.claim ? 'claimed' : 'open'),
    },
  };
}

function permissionClaimRepository(rows: any[]) {
  const initialGroups = new Map<string, any[]>();
  for (const row of rows) {
    row.sourceAgentFolder ??= row.payload.sourceAgentFolder;
    row.requestId ??= row.payload.requestId;
    if (row.runLeaseToken === null && row.payload.runLeaseToken) {
      row.runLeaseToken = row.payload.runLeaseToken;
    }
    if (
      row.runLeaseFencingVersion === null &&
      row.payload.runLeaseFencingVersion
    ) {
      row.runLeaseFencingVersion = row.payload.runLeaseFencingVersion;
    }
    row.envelopeId ??= null;
    row.memberIndex ??= null;
    row.promptFixture ??= {
      interactionId: row.requestId,
      providerAliases: [],
    };
    const groupId = `${row.appId}:${row.sourceAgentFolder}:${row.promptFixture.interactionId}`;
    const group = initialGroups.get(groupId) ?? [];
    group.push(row);
    initialGroups.set(groupId, group);
  }
  const prompts: any[] = [];
  for (const group of initialGroups.values()) {
    const fixture = group[0]!.promptFixture;
    const interactionId = fixture.interactionId;
    const aliases = [
      ...new Set(
        group.flatMap((row) => row.promptFixture.providerAliases ?? []),
      ),
    ];
    const renderedRequest = {
      ...group[0]!.payload.request,
      requestId: interactionId,
      ...(group.length > 1
        ? {
            permissionBatch: {
              requestIds: group.map((row) => row.requestId),
              rows: [],
            },
          }
        : {}),
    };
    const promptId = `prompt:${prompts.length + 1}`;
    const initialClaim = group.find((row) => row.promptFixture.claim)
      ?.promptFixture.claim;
    const prompt = {
      id: promptId,
      parentEnvelopeId: null,
      appId: group[0]!.appId,
      sourceAgentFolder: group[0]!.sourceAgentFolder,
      interactionId,
      matchKind: group.length > 1 ? 'batch' : 'individual',
      memberCount: group.length,
      envelope: {
        version: 1,
        renderedDecisionOptions: [
          'allow_once',
          'allow_persistent_rule',
          'cancel',
        ],
        targetJid: renderedRequest.targetJid ?? null,
        approvalContextJid:
          renderedRequest.approvalContextJid ??
          renderedRequest.targetJid ??
          null,
        threadId: renderedRequest.threadId ?? null,
        decisionPolicy: renderedRequest.decisionPolicy ?? null,
        renderedRequest,
      },
      fullView: null,
      externalPromptProvider: fixture.externalPromptProvider ?? null,
      externalPromptConversationId:
        fixture.externalPromptConversationId ?? null,
      externalPromptMessageId: fixture.externalPromptMessageId ?? null,
      externalPromptThreadId: fixture.externalPromptThreadId ?? null,
      providerAliases: aliases,
      claim: initialClaim
        ? {
            ...initialClaim,
            match: { ...initialClaim.match, providerAliases: aliases },
          }
        : null,
      settlementState: fixture.settlementState ?? 'open',
      settledAt:
        fixture.settlementState === 'settled'
          ? '2026-07-16T00:01:00.000Z'
          : null,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    prompts.push(prompt);
    group.forEach((row, index) => {
      row.envelopeId = promptId;
      row.memberIndex = index;
    });
  }
  const groupForPrompt = (prompt: any, includeResolved = false) => ({
    prompt,
    members: rows
      .filter(
        (row) =>
          row.envelopeId === prompt.id &&
          (includeResolved || row.status === 'pending'),
      )
      .sort((a, b) => a.memberIndex - b.memberIndex),
  });
  const findPrompt = (scope: any) =>
    prompts
      .filter(
        (prompt) =>
          prompt.appId === scope.appId &&
          prompt.sourceAgentFolder === scope.sourceAgentFolder &&
          prompt.interactionId === scope.interactionId &&
          prompt.settlementState !== 'superseded',
      )
      .at(-1);
  const lookups = pendingInteractionLookups(rows);
  return {
    rows,
    prompts,
    ...lookups,
    updatePendingInteractionPayload: payloadUpdater(rows),
    bindPendingPermissionPrompt: vi.fn(async (input: any) => {
      const members = input.members.map((member: any) =>
        rows.find(
          (row) =>
            row.idempotencyKey === member.idempotencyKey &&
            row.requestId === member.requestId &&
            row.sourceAgentFolder === input.sourceAgentFolder &&
            row.status === 'pending',
        ),
      );
      if (
        members.some((member: any) => !member) ||
        new Set(members).size !== input.members.length ||
        input.members.some(
          (member: any, index: number) => member.index !== index,
        )
      ) {
        return null;
      }
      const oldPrompts = [
        ...new Set(
          members.flatMap((member: any) =>
            member.envelopeId
              ? prompts.filter((prompt) => prompt.id === member.envelopeId)
              : [],
          ),
        ),
      ];
      if (
        oldPrompts.some((prompt: any) =>
          ['claimed', 'review_each_expired'].includes(prompt.settlementState),
        )
      ) {
        return null;
      }
      const parentIds = [
        ...new Set(
          oldPrompts.flatMap((prompt: any) =>
            input.matchKind === 'individual' &&
            prompt.matchKind === 'batch' &&
            prompt.settlementState === 'settled' &&
            prompt.claim?.intent.mode === 'allow_persistent_rule'
              ? [prompt.id]
              : prompt.parentEnvelopeId
                ? [prompt.parentEnvelopeId]
                : [],
          ),
        ),
      ];
      if (parentIds.length > 1) return null;
      for (const oldPrompt of oldPrompts) {
        if (oldPrompt.settlementState === 'open') {
          oldPrompt.settlementState = 'superseded';
        }
      }
      const now = input.now ?? '2026-07-16T00:00:00.000Z';
      const prompt = {
        id: input.id,
        parentEnvelopeId: parentIds[0] ?? null,
        appId: input.appId,
        sourceAgentFolder: input.sourceAgentFolder,
        interactionId: input.interactionId,
        matchKind: input.matchKind,
        memberCount: input.members.length,
        envelope: input.envelope,
        fullView: input.fullView ?? null,
        externalPromptProvider: input.externalPromptProvider ?? null,
        externalPromptConversationId:
          input.externalPromptConversationId ?? null,
        externalPromptMessageId: input.externalPromptMessageId ?? null,
        externalPromptThreadId: input.externalPromptThreadId ?? null,
        providerAliases: [...new Set(input.providerAliases)],
        claim: null,
        settlementState: 'open',
        settledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      prompts.push(prompt);
      members.forEach((member: any, index: number) => {
        member.envelopeId = prompt.id;
        member.memberIndex = index;
      });
      return groupForPrompt(prompt);
    }),
    findPendingPermissionPrompt: vi.fn(async ({ scope }: any) => {
      const prompt = findPrompt(scope);
      return prompt ? groupForPrompt(prompt) : null;
    }),
    findPendingPermissionPromptByMember: vi.fn(async (input: any) => {
      const member = rows.find(
        (row) =>
          row.appId === input.appId &&
          row.sourceAgentFolder === input.sourceAgentFolder &&
          row.requestId === input.requestId &&
          row.status === 'pending' &&
          row.envelopeId,
      );
      const prompt = member
        ? prompts.find((candidate) => candidate.id === member.envelopeId)
        : null;
      return prompt ? groupForPrompt(prompt) : null;
    }),
    findPendingPermissionPromptByMessage: vi.fn(async (input: any) => {
      const matching = prompts.filter(
        (prompt) =>
          prompt.appId === input.appId &&
          prompt.externalPromptProvider === input.provider &&
          prompt.externalPromptConversationId === input.conversationId &&
          prompt.externalPromptMessageId === input.externalMessageId &&
          prompt.externalPromptThreadId === (input.threadId ?? null) &&
          prompt.settlementState !== 'superseded',
      );
      return matching.length === 1 ? groupForPrompt(matching[0]) : null;
    }),
    claimPendingPermissionCallback: vi.fn(async ({ claim }: any) => {
      const prompt = findPrompt(claim.scope);
      if (
        !prompt ||
        prompt.settlementState !== 'open' ||
        prompt.claim ||
        prompt.matchKind !== claim.match.kind ||
        prompt.memberCount !== groupForPrompt(prompt).members.length ||
        (claim.match.providerAliases[0] &&
          !prompt.providerAliases.includes(claim.match.providerAliases[0]))
      ) {
        return null;
      }
      prompt.claim = {
        ...claim,
        match: { ...claim.match, providerAliases: prompt.providerAliases },
      };
      prompt.settlementState = 'claimed';
      return groupForPrompt(prompt);
    }),
    releasePendingPermissionCallback: vi.fn(async ({ claim }: any) => {
      const prompt = findPrompt(claim.scope);
      if (
        !prompt ||
        prompt.settlementState !== 'claimed' ||
        prompt.claim?.id !== claim.id
      ) {
        return false;
      }
      prompt.claim = null;
      prompt.settlementState = 'open';
      prompt.settledAt = null;
      return true;
    }),
    settlePendingPermissionCallback: vi.fn(async ({ claim }: any) => {
      const prompt = findPrompt(claim.scope);
      if (!prompt || prompt.claim?.id !== claim.id) return false;
      if (prompt.settlementState === 'settled') return true;
      if (prompt.settlementState !== 'claimed') return false;
      prompt.settlementState = 'settled';
      prompt.settledAt = '2026-07-16T00:01:00.000Z';
      return true;
    }),
    expirePendingPermissionReviewEach: vi.fn(async ({ claim, now }: any) => {
      const prompt = findPrompt(claim.scope);
      if (
        !prompt ||
        !['claimed', 'settled'].includes(prompt.settlementState) ||
        prompt.claim?.id !== claim.id ||
        prompt.matchKind !== 'batch' ||
        prompt.claim.intent.mode !== 'allow_persistent_rule'
      ) {
        return null;
      }
      prompt.settlementState = 'review_each_expired';
      prompt.settledAt = now;
      prompt.updatedAt = now;
      return groupForPrompt(prompt);
    }),
    resolvePendingInteraction: vi.fn(async (input: any) => {
      const row = rows.find(
        (candidate) => candidate.idempotencyKey === input.idempotencyKey,
      );
      if (!row) return false;
      const prompt = prompts.find(
        (candidate) => candidate.id === row.envelopeId,
      );
      const claimMatches = input.permissionCallbackClaim
        ? prompt?.settlementState === 'review_each_expired'
          ? input.permissionCallbackClaim.id ===
              `${prompt.claim?.id}:expired:${row.requestId}` &&
            input.permissionCallbackClaim.scope.interactionId === row.requestId
          : ['claimed', 'settled'].includes(prompt?.settlementState) &&
            prompt?.claim?.id === input.permissionCallbackClaim.id &&
            prompt.interactionId ===
              input.permissionCallbackClaim.scope.interactionId
        : !prompt?.claim;
      if (!claimMatches) {
        return false;
      }
      if (row.status !== 'pending') {
        return row.status === input.status;
      }
      if (prompt?.settlementState === 'claimed') {
        prompt.settlementState = 'settled';
        prompt.settledAt = input.now ?? '2026-07-16T00:01:00.000Z';
      }
      row.status = input.status;
      row.resolution = input.resolution;
      return true;
    }),
  };
}

describe('pending interaction durability', () => {
  afterEach(() => {
    configurePendingInteractionDurability(null);
  });

  it.each(['', '   '])(
    'rejects durable approval without a concrete approver identity (%s)',
    async (approverRef) => {
      const repository = {
        claimPendingPermissionCallback: vi.fn(async () => []),
      };
      configurePendingInteractionDurability({
        repository: repository as never,
      });

      await expect(
        claimPermissionInteractionCallback({
          scope: {
            appId: 'default',
            sourceAgentFolder: 'agent-folder',
            interactionId: 'permission-unauthorized',
          },
          mode: 'allow_once',
          approverRef,
          matchKind: 'individual',
        }),
      ).resolves.toEqual({ status: 'retryable' });

      expect(repository.claimPendingPermissionCallback).not.toHaveBeenCalled();
    },
  );

  it.each(['runtime', 'system', 'auto_classifier'])(
    'rejects reserved decider %s for non-cancel permission claims',
    async (approverRef) => {
      const repository = {
        claimPendingPermissionCallback: vi.fn(async () => []),
      };
      configurePendingInteractionDurability({
        repository: repository as never,
      });

      await expect(
        claimPermissionInteractionCallback({
          scope: {
            appId: 'default',
            sourceAgentFolder: 'agent-folder',
            interactionId: 'permission-reserved-decider',
          },
          mode: 'allow_once',
          approverRef,
          matchKind: 'individual',
        }),
      ).resolves.toEqual({ status: 'retryable' });
      expect(repository.claimPendingPermissionCallback).not.toHaveBeenCalled();
    },
  );

  it('keeps a pending callback retryable when the claim repository fails', async () => {
    const row = permissionRow({
      id: 'permission-claim-failure',
      agent: 'agent-folder',
      requestId: 'permission-retryable',
      alias: 'opaque-retryable',
    });
    const repository = {
      claimPendingPermissionCallback: vi.fn(async () => {
        throw new Error('postgres unavailable');
      }),
    };
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      claimPermissionInteractionCallback({
        scope: {
          appId: 'default',
          sourceAgentFolder: 'agent-folder',
          interactionId: 'permission-retryable',
        },
        mode: 'allow_once',
        approverRef: 'user:approver',
        matchKind: 'individual',
        providerAlias: 'opaque-retryable',
      }),
    ).resolves.toEqual({ status: 'retryable' });

    expect(row.status).toBe('pending');
    expect(row.promptFixture.providerAliases).toEqual(['opaque-retryable']);
  });

  it.each([
    ['a valid holder', true, 'already_decided'],
    ['a matching pending row without a holder', false, 'retryable'],
  ] as const)(
    'classifies a zero-row permission claim with %s',
    async (_label, hasHolder, expectedStatus) => {
      const scope = {
        appId: 'default',
        sourceAgentFolder: 'agent-folder',
        interactionId: 'permission-zero-row',
      };
      const row = permissionRow({
        id: 'permission-zero-row',
        agent: scope.sourceAgentFolder,
        requestId: scope.interactionId,
      });
      const repository = permissionClaimRepository([row]);
      repository.claimPendingPermissionCallback.mockResolvedValue(null);
      if (hasHolder) {
        repository.prompts[0].claim = {
          id: 'existing-claim',
          scope,
          intent: {
            mode: 'allow_once',
            approverRef: 'user:holder',
            decidedAt: '2026-07-16T00:00:00.000Z',
          },
          match: {
            kind: 'individual',
            canonicalId: scope.interactionId,
            providerAliases: [],
          },
        };
        repository.prompts[0].settlementState = 'claimed';
      }
      configurePendingInteractionDurability({
        repository: repository as never,
      });

      await expect(
        claimPermissionInteractionCallback({
          scope,
          mode: 'cancel',
          approverRef: 'system',
          matchKind: 'individual',
        }),
      ).resolves.toEqual({ status: expectedStatus });
    },
  );

  it('marks an already-decided permission claim as ownerless when the row is gone', async () => {
    configurePendingInteractionDurability({
      repository: {
        claimPendingPermissionCallback: vi.fn(async () => null),
        findPendingPermissionPrompt: vi.fn(async () => null),
      } as never,
    });

    await expect(
      claimPermissionInteractionCallback({
        scope: {
          appId: 'default',
          sourceAgentFolder: 'agent-folder',
          interactionId: 'permission-expired',
        },
        mode: 'cancel',
        approverRef: 'system',
        matchKind: 'individual',
      }),
    ).resolves.toEqual({ status: 'already_decided', ownerless: true });
  });

  it('distinguishes a terminal settlement from a retryable unclaimed row', async () => {
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-folder',
      interactionId: 'permission-settled',
    };
    const row = permissionRow({
      id: 'permission-settled',
      agent: scope.sourceAgentFolder,
      requestId: scope.interactionId,
    });
    const settlement = {
      id: 'settled-claim',
      scope,
      intent: {
        mode: 'allow_once',
        approverRef: 'user:approver',
        decidedAt: '2026-07-16T00:00:00.000Z',
      },
      match: {
        kind: 'individual',
        canonicalId: scope.interactionId,
        providerAliases: [],
      },
      settledAt: '2026-07-16T00:01:00.000Z',
    };
    const repository = permissionClaimRepository([row]);
    repository.prompts[0].claim = settlement;
    repository.prompts[0].settlementState = 'settled';
    repository.prompts[0].settledAt = settlement.settledAt;
    repository.claimPendingPermissionCallback.mockResolvedValue(null);
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      claimPermissionInteractionCallback({
        scope,
        mode: 'cancel',
        approverRef: 'system',
        matchKind: 'individual',
      }),
    ).resolves.toEqual({ status: 'already_decided' });
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
    const request = {
      requestId: 'perm-1',
      sourceAgentFolder: 'main_agent',
      targetJid: 'sl:C123',
      threadId: '1710000000.111111',
      toolName: 'Bash',
    };
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
        request,
      },
      callbackRoute: null,
      idempotencyKey: 'default:permission:main_agent:perm-1',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-23T00:00:00.000Z',
      expiresAt: '2026-06-24T00:00:00.000Z',
      resolvedAt: null,
    };
    const repository = permissionClaimRepository([pending]);
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      bindPendingPermissionInteractionMessage({
        request,
        decisionOptions: ['allow_once', 'cancel'],
        externalMessageId: '1710000000.400500',
        provider: 'slack',
        conversationId: 'C123',
      }),
    ).resolves.toBe(true);

    expect(repository.prompts.at(-1)).toMatchObject({
      externalPromptMessageId: '1710000000.400500',
      externalPromptProvider: 'slack',
      externalPromptConversationId: 'C123',
      externalPromptThreadId: '1710000000.111111',
      envelope: expect.objectContaining({
        renderedDecisionOptions: ['allow_once', 'cancel'],
      }),
    });
  });

  it('binds permission prompt messages in the request app scope', async () => {
    const request = {
      appId: 'app:two',
      requestId: 'perm-2',
      sourceAgentFolder: 'main_agent',
      toolName: 'Bash',
    };
    const pending = {
      id: 'pending-permission-2',
      appId: 'app:two',
      kind: 'permission',
      status: 'pending',
      payload: {
        requestId: 'perm-2',
        sourceAgentFolder: 'main_agent',
        request,
      },
      callbackRoute: null,
      idempotencyKey: 'app:two:permission:main_agent:perm-2',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-23T00:00:00.000Z',
      expiresAt: '2026-06-24T00:00:00.000Z',
      resolvedAt: null,
    };
    const repository = permissionClaimRepository([pending]);
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      bindPendingPermissionInteractionMessage({
        request,
        decisionOptions: ['cancel'],
        externalMessageId: 'message-2',
      }),
    ).resolves.toBe(true);

    expect(repository.bindPendingPermissionPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app:two' }),
    );
  });

  it('supersedes an open prompt when its provider callback alias changes', async () => {
    const row = permissionRow({
      id: 'individual-after-batch',
      agent: 'agent-a',
      requestId: 'req-individual-after-batch',
      alias: 'old-batch-alias',
    });
    const repository = permissionClaimRepository([row]);
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      bindPendingPermissionInteractionMessage({
        request: row.payload.request,
        decisionOptions: ['allow_once', 'cancel'],
        callbackId: 'new-individual-alias',
      }),
    ).resolves.toBe(true);
    expect(repository.prompts.at(-1)).toMatchObject({
      interactionId: 'req-individual-after-batch',
      matchKind: 'individual',
      providerAliases: ['new-individual-alias'],
    });
    expect(repository.prompts.at(-2)).toMatchObject({
      settlementState: 'superseded',
    });

    await expect(
      claimPermissionInteractionCallback({
        scope: {
          appId: 'default',
          sourceAgentFolder: 'agent-a',
          interactionId: 'req-individual-after-batch',
        },
        mode: 'allow_once',
        approverRef: 'user:a',
        matchKind: 'individual',
        providerAlias: 'new-individual-alias',
      }),
    ).resolves.toMatchObject({ status: 'claimed' });
  });

  it('persists a redacted permission full-view payload with the prompt binding', async () => {
    const request = {
      requestId: 'perm-full-view',
      sourceAgentFolder: 'main_agent',
      targetJid: 'sl:C123',
      decisionPolicy: 'same_channel' as const,
      toolName: 'Bash',
      description: 'raw-description-secret',
      interaction: {
        id: 'permission-detail',
        title: 'Permission detail',
        files: [{ path: '/private/input', preview: 'raw-file-secret' }],
      },
      toolInput: {
        command: 'raw-command-secret',
        file_path: '/raw/private/file',
        credential: 'raw-credential-secret',
      },
      toolInputSanitized: true,
      toolInputSanitizedPaths: ['command', 'file_path', 'credential'],
    };
    const pending = {
      id: 'pending-permission-full-view',
      appId: 'default',
      kind: 'permission',
      status: 'pending',
      payload: {
        requestId: 'perm-full-view',
        sourceAgentFolder: 'main_agent',
        targetJid: 'sl:C123',
        decisionPolicy: 'same_channel',
        request,
      },
      callbackRoute: null,
      idempotencyKey: 'default:permission:main_agent:perm-full-view',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-23T00:00:00.000Z',
      expiresAt: '2026-06-24T00:00:00.000Z',
      resolvedAt: null,
    };
    const repository = permissionClaimRepository([pending]);
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      bindPendingPermissionInteractionMessage({
        request,
        decisionOptions: ['allow_once', 'cancel'],
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
        scope: {
          appId: 'default',
          sourceAgentFolder: 'main_agent',
          interactionId: 'perm-full-view',
        },
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
    const envelope = repository.prompts.at(-1).envelope as any;
    expect(envelope.renderedRequest).toMatchObject({
      toolInputSanitized: true,
      toolInputSanitizedPaths: ['command', 'file_path', 'credential'],
    });
    expect(envelope.renderedRequest).not.toHaveProperty('toolInput');
    expect(envelope.renderedRequest).not.toHaveProperty('description');
    expect(envelope.renderedRequest).not.toHaveProperty('interaction');
    expect(JSON.stringify(envelope)).not.toContain('raw-command-secret');
    expect(JSON.stringify(envelope)).not.toContain('/raw/private/file');
    expect(JSON.stringify(envelope)).not.toContain('raw-credential-secret');
    expect(JSON.stringify(envelope)).not.toContain('raw-description-secret');
    expect(JSON.stringify(envelope)).not.toContain('raw-file-secret');
  });

  it('recovers the rendered non-bulk option set and approval context from one shared envelope', async () => {
    const rows = [
      permissionRow({ id: 'non-bulk-1', agent: 'agent-a', requestId: 'req-1' }),
      permissionRow({ id: 'non-bulk-2', agent: 'agent-a', requestId: 'req-2' }),
    ];
    const batchRequest = {
      ...rows[0]!.payload.request,
      requestId: 'batch:req-1:2',
      targetJid: 'sl:prompt-target',
      approvalContextJid: 'sl:approval-context',
      permissionBatch: { requestIds: ['req-1', 'req-2'], rows: ['a', 'b'] },
    };
    const repository = permissionClaimRepository(rows);
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      bindPendingPermissionInteractionMessage({
        request: batchRequest,
        decisionOptions: ['allow_persistent_rule', 'cancel'],
        callbackId: 'non-bulk-alias',
      }),
    ).resolves.toBe(true);

    await expect(
      findDurablePermissionInteractionByRequestId({
        scope: {
          appId: 'default',
          sourceAgentFolder: 'agent-a',
          interactionId: batchRequest.requestId,
        },
        providerAlias: 'non-bulk-alias',
      }),
    ).resolves.toMatchObject({
      targetJid: 'sl:prompt-target',
      approvalContextJid: 'sl:approval-context',
      decisionOptions: ['allow_persistent_rule', 'cancel'],
    });
  });

  it('finds a permission prompt only by exact provider message binding', async () => {
    const row = permissionPromptRow({
      id: 'pending-permission-1',
      agent: 'main_agent',
      requestId: 'perm-1',
      messageId: '1710000000.400500',
      payload: {
        decisionPolicy: 'same_channel',
        externalPromptThreadId: '1710000000.111111',
        request: {
          requestId: 'perm-1',
          sourceAgentFolder: 'main_agent',
          targetJid: 'sl:C123',
          threadId: '1710000000.111111',
          decisionPolicy: 'same_channel',
          toolName: 'Bash',
        },
      },
    });
    const repository = permissionClaimRepository([row]);
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
    ).resolves.toMatchObject({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'main_agent',
        interactionId: 'perm-1',
      },
      requestId: 'perm-1',
      matchKind: 'individual',
      providerAlias: null,
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

  it('locates the exact prompt scope when request ids collide across agents', async () => {
    const rows = [
      permissionPromptRow({
        id: 'prompt-agent-a',
        agent: 'agent-a',
        requestId: 'same-request',
        messageId: 'message-a',
        providerAliases: ['alias-a'],
      }),
      permissionPromptRow({
        id: 'prompt-agent-b',
        agent: 'agent-b',
        requestId: 'same-request',
        messageId: 'message-b',
        providerAliases: ['alias-b'],
      }),
    ];
    const repository = permissionClaimRepository(rows);
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      findDurablePermissionInteractionByPromptMessage({
        appId: 'default',
        provider: 'slack',
        conversationId: 'C123',
        externalMessageId: 'message-b',
        threadId: 'thread-1',
        providerAlias: 'alias-b',
      }),
    ).resolves.toMatchObject({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-b',
        interactionId: 'same-request',
      },
      matchKind: 'individual',
      providerAlias: 'alias-b',
    });
  });

  it('fails closed when one prompt identity maps to different agents', async () => {
    const rows = [
      permissionPromptRow({
        id: 'mixed-agent-a',
        agent: 'agent-a',
        requestId: 'same-request',
        messageId: 'mixed-agent-message',
      }),
      permissionPromptRow({
        id: 'mixed-agent-b',
        agent: 'agent-b',
        requestId: 'same-request',
        messageId: 'mixed-agent-message',
      }),
    ];
    const repository = permissionClaimRepository(rows);
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      findDurablePermissionInteractionByPromptMessage({
        provider: 'slack',
        conversationId: 'C123',
        externalMessageId: 'mixed-agent-message',
        threadId: 'thread-1',
      }),
    ).resolves.toBeNull();
  });

  it('fails closed when one prompt identity has inconsistent batch markers', async () => {
    const rows = [
      permissionPromptRow({
        id: 'mixed-1',
        agent: 'agent-a',
        requestId: 'req-1',
        messageId: 'mixed-message',
        interactionId: 'batch:req-1:2',
      }),
      permissionPromptRow({
        id: 'mixed-2',
        agent: 'agent-a',
        requestId: 'req-2',
        messageId: 'mixed-message',
        interactionId: 'batch:req-2:2',
      }),
    ];
    const repository = permissionClaimRepository(rows);
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      findDurablePermissionInteractionByPromptMessage({
        provider: 'slack',
        conversationId: 'C123',
        externalMessageId: 'mixed-message',
        threadId: 'thread-1',
      }),
    ).resolves.toBeNull();
  });

  it('locates one active batch only by its shared actual marker', async () => {
    const batchId = 'batch:req-1:2';
    const rows = [
      permissionPromptRow({
        id: 'batch-1',
        agent: 'agent-a',
        requestId: 'req-1',
        messageId: 'batch-message',
        interactionId: batchId,
        providerAliases: ['batch-alias'],
      }),
      permissionPromptRow({
        id: 'batch-2',
        agent: 'agent-a',
        requestId: 'req-2',
        messageId: 'batch-message',
        interactionId: batchId,
        providerAliases: ['batch-alias'],
      }),
    ];
    const repository = permissionClaimRepository(rows);
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      findDurablePermissionInteractionByPromptMessage({
        provider: 'slack',
        conversationId: 'C123',
        externalMessageId: 'batch-message',
        threadId: 'thread-1',
        providerAlias: 'batch-alias',
      }),
    ).resolves.toMatchObject({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: batchId,
      },
      requestId: batchId,
      matchKind: 'batch',
      providerAlias: 'batch-alias',
    });
  });

  it('returns one persisted claimed scope by prompt identity and exact provider alias', async () => {
    const claim = {
      id: 'claim-restart-batch',
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: 'batch:req-1:2',
      },
      intent: {
        mode: 'allow_once',
        approverRef: 'user:a',
        decidedAt: '2026-07-16T00:00:00.000Z',
      },
      match: {
        kind: 'batch',
        canonicalId: 'batch:req-1:2',
        providerAliases: ['claimed-alias'],
      },
    } as const;
    const rows = [
      permissionPromptRow({
        id: 'claimed-1',
        agent: 'agent-a',
        requestId: 'req-1',
        messageId: 'claimed-message',
        claim,
      }),
      permissionPromptRow({
        id: 'claimed-2',
        agent: 'agent-a',
        requestId: 'req-2',
        messageId: 'claimed-message',
        claim: {
          ...claim,
          match: {
            ...claim.match,
            providerAliases: ['claimed-alias-b'],
          },
        },
      }),
    ];
    for (const [index, row] of rows.entries()) {
      row.promptFixture.interactionId = claim.scope.interactionId;
      row.promptFixture.providerAliases = [
        index === 0 ? 'claimed-alias' : 'claimed-alias-b',
      ];
    }
    const repository = permissionClaimRepository(rows);
    configurePendingInteractionDurability({ repository: repository as never });
    const locator = {
      provider: 'slack',
      conversationId: 'C123',
      externalMessageId: 'claimed-message',
      threadId: 'thread-1',
    };

    await expect(
      findDurablePermissionInteractionByPromptMessage(locator),
    ).resolves.toMatchObject({
      scope: claim.scope,
      matchKind: 'batch',
      providerAlias: 'claimed-alias',
      claim: {
        ...claim,
        match: {
          ...claim.match,
          providerAliases: ['claimed-alias', 'claimed-alias-b'],
        },
      },
    });
    await expect(
      findDurablePermissionInteractionByPromptMessage({
        ...locator,
        providerAlias: 'wrong-alias',
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
    await expect(
      resolvePendingInteractionRecordOutcome({
        kind: 'permission',
        sourceAgentFolder: 'main_agent',
        requestId: 'perm-missing',
        appId: 'app:test',
        runId: null,
        status: 'resolved',
        resolution: { approved: true },
        approverRef: 'owner',
      }),
    ).resolves.toBe('rejected');
  });

  it('classifies durable resolution exceptions as retryable', async () => {
    const repository = {
      resolvePendingInteraction: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      resolvePendingInteractionRecordOutcome({
        kind: 'permission',
        sourceAgentFolder: 'main_agent',
        requestId: 'perm-retryable',
        appId: 'app:test',
        runId: null,
        status: 'resolved',
        resolution: { approved: true },
        approverRef: 'owner',
      }),
    ).resolves.toBe('retryable_error');
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
      idempotencyKey: 'default:permission:agent-folder:req-1',
      status: 'resolved',
      resolution: { approved: true, mode: 'allow_once' },
      approverRef: 'user:approver',
      permissionCallbackClaim: null,
    });
  });

  it('hands the durable command to the winning interaction CAS', async () => {
    const queuedCommands: unknown[] = [];
    const rows = [
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
        idempotencyKey: 'default:permission:agent-folder:req-1',
        approverRef: null,
        resolution: null,
        createdAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-11T00:00:00.000Z',
        resolvedAt: null,
      },
    ];
    const repository = {
      ...pendingInteractionLookups(rows),
      resolvePendingInteraction: vi.fn(async (input: any) => {
        if (input.liveTurnCommand) queuedCommands.push(input.liveTurnCommand);
        return true;
      }),
    };
    const liveTurns = {
      findActiveLiveTurnByRunId: vi.fn(async () => ({ id: 'turn-1' })),
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

    expect(queuedCommands).toEqual([
      expect.objectContaining({
        liveTurnId: 'turn-1',
        commandType: 'interaction_resolved',
        idempotencyKey:
          'interaction_resolved:default:permission:agent-folder:req-1',
        payload: expect.objectContaining({
          kind: 'permission',
          requestId: 'req-1',
          callbackRoute: expect.objectContaining({
            ipcBaseDir: '/tmp/ipc',
            responseKeyId: 'key-1',
          }),
        }),
      }),
    ]);
    expect(repository.resolvePendingInteraction).toHaveBeenCalledOnce();
  });

  it('does not queue a durable command when the interaction CAS loses', async () => {
    const queuedCommands: unknown[] = [];
    const rows = [
      {
        id: 'pending-1',
        appId: 'default',
        runId: 'run-1',
        kind: 'permission',
        status: 'pending',
        payload: {},
        callbackRoute: { ipcBaseDir: '/tmp/ipc' },
        idempotencyKey: 'default:permission:agent-folder:req-1',
        approverRef: null,
        resolution: null,
        createdAt: '2026-06-10T00:00:00.000Z',
        expiresAt: '2026-06-11T00:00:00.000Z',
        resolvedAt: null,
      },
    ];
    const repository = {
      ...pendingInteractionLookups(rows),
      resolvePendingInteraction: vi.fn(async (input: any) => {
        const casWon = false;
        if (casWon && input.liveTurnCommand) {
          queuedCommands.push(input.liveTurnCommand);
        }
        return casWon;
      }),
    };
    const liveTurns = {
      findActiveLiveTurnByRunId: vi.fn(async () => ({ id: 'turn-1' })),
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
    ).resolves.toBe(false);

    expect(queuedCommands).toEqual([]);
    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        liveTurnCommand: expect.objectContaining({
          idempotencyKey:
            'interaction_resolved:default:permission:agent-folder:req-1',
        }),
      }),
    );
  });

  it('recovers the target JID from the real persisted permission payload shape', async () => {
    const row = permissionRow({
      id: 'pending-1',
      agent: 'agent-folder',
      requestId: 'req-1',
    });
    row.payload.request = {
      ...row.payload.request,
      targetJid: 'chat-1',
      decisionPolicy: 'same_channel',
    };
    const repository = permissionClaimRepository([row]);
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      findDurablePermissionInteractionByRequestId({
        scope: {
          appId: 'default',
          sourceAgentFolder: 'agent-folder',
          interactionId: 'req-1',
        },
      }),
    ).resolves.toMatchObject({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-folder',
        interactionId: 'req-1',
      },
      requestId: 'req-1',
      batchCallbackId: null,
      sourceAgentFolder: 'agent-folder',
      targetJid: 'chat-1',
      threadId: null,
      decisionPolicy: 'same_channel',
      providerAliases: [],
    });
  });

  it('recovers alias-divergent sibling rows by scope and preserves the persisted intent', async () => {
    const batchId = 'batch:alias-divergent:2';
    const rows = [
      permissionRow({
        id: 'alias-divergent-1',
        agent: 'agent-a',
        requestId: 'alias-divergent-request-1',
        alias: 'alias-one',
        batchId,
      }),
      permissionRow({
        id: 'alias-divergent-2',
        agent: 'agent-a',
        requestId: 'alias-divergent-request-2',
        alias: 'alias-two',
        batchId,
      }),
    ];
    const repository = permissionClaimRepository(rows);
    const applyDecision = vi.fn(async () => true);
    configurePendingInteractionDurability({
      repository: repository as never,
    });
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision,
      resolve: (input) =>
        repository.resolvePendingInteraction({
          idempotencyKey: `default:permission:agent-a:${input.requestId}`,
          ...input,
        }),
    });
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      interactionId: batchId,
    };
    const original = await claimPermissionInteractionCallback({
      scope,
      mode: 'allow_once',
      approverRef: 'user:original',
      matchKind: 'batch',
      providerAlias: 'alias-one',
      claimedAt: '2026-07-19T00:00:00.000Z',
      claimId: 'alias-divergent-claim',
    });
    expect(original.status).toBe('claimed');
    const terminalize = vi.fn(async () => true);
    const feedback = vi.fn(async () => {});

    await expect(
      recoverDurablePermissionDecision({
        locator: {
          kind: 'scope',
          scope,
          matchKind: 'batch',
          providerAlias: 'alias-two',
        },
        surfaceJid: 'sl:C123',
        incomingMode: 'allow_persistent_rule',
        incomingApprover: 'user:later',
        authorize: vi.fn(async () => true),
        terminalize,
        feedback,
      }),
    ).resolves.toBe('resolved');

    expect(terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        decision: expect.objectContaining({
          approved: true,
          mode: 'allow_once',
          decidedBy: 'user:original',
        }),
      }),
    );
    expect(feedback).toHaveBeenCalledWith('Decision recorded.');
    expect(applyDecision).toHaveBeenCalledTimes(2);
    expect(rows.map((row) => row.status)).toEqual(['resolved', 'resolved']);
  });

  it('recovers a durable permission by provider message through transport hooks', async () => {
    const row = permissionPromptRow({
      id: 'message-locator-row',
      agent: 'agent-a',
      requestId: 'message-locator-request',
      messageId: 'message-locator-prompt',
      providerAliases: ['message-locator-alias'],
    });
    const repository = permissionClaimRepository([row]);
    configurePendingInteractionDurability({
      repository: repository as never,
    });
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async () => true),
      resolve: (input) =>
        repository.resolvePendingInteraction({
          idempotencyKey: row.idempotencyKey,
          ...input,
        }),
    });
    const terminalize = vi.fn(async () => true);

    await expect(
      recoverDurablePermissionDecision({
        locator: {
          kind: 'message',
          appId: 'default',
          provider: 'slack',
          conversationId: 'C123',
          externalMessageId: 'message-locator-prompt',
          threadId: 'thread-1',
          providerAlias: 'message-locator-alias',
        },
        surfaceJid: 'sl:C123',
        incomingMode: 'allow_once',
        incomingApprover: 'user:approver',
        authorize: vi.fn(async () => true),
        terminalize,
        feedback: vi.fn(async () => {}),
      }),
    ).resolves.toBe('resolved');

    expect(terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        request: row.payload.request,
      }),
    );
    expect(row.status).toBe('resolved');
  });

  it('rejects a wrong-surface recovered click with visible feedback', async () => {
    const row = permissionRow({
      id: 'wrong-surface-row',
      agent: 'agent-a',
      requestId: 'wrong-surface-request',
      alias: 'wrong-surface-alias',
    });
    const repository = permissionClaimRepository([row]);
    configurePendingInteractionDurability({
      repository: repository as never,
    });
    const authorize = vi.fn(async () => true);
    const terminalize = vi.fn(async () => true);
    const feedback = vi.fn(async () => {});

    await expect(
      recoverDurablePermissionDecision({
        locator: {
          kind: 'scope',
          scope: {
            appId: 'default',
            sourceAgentFolder: 'agent-a',
            interactionId: 'wrong-surface-request',
          },
          matchKind: 'individual',
          providerAlias: 'wrong-surface-alias',
        },
        surfaceJid: 'sl:C999',
        incomingMode: 'allow_once',
        incomingApprover: 'user:approver',
        authorize,
        terminalize,
        feedback,
      }),
    ).resolves.toBe('wrong_surface');

    expect(feedback).toHaveBeenCalledWith(
      'This approval request belongs to a different chat.',
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(terminalize).not.toHaveBeenCalled();
    expect(repository.claimPendingPermissionCallback).not.toHaveBeenCalled();
  });

  it('terminalizes a stale prompt when durable recovery misses', async () => {
    const repository = {
      findPendingPermissionPromptByMessage: vi.fn(async () => null),
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });
    const terminalize = vi.fn(async () => true);
    const feedback = vi.fn(async () => {});

    await expect(
      recoverDurablePermissionDecision({
        locator: {
          kind: 'message',
          appId: 'default',
          provider: 'telegram',
          conversationId: '123',
          externalMessageId: 'stale-message',
          providerAlias: 'stale-alias',
        },
        surfaceJid: 'tg:123',
        incomingMode: 'allow_once',
        incomingApprover: 'user:approver',
        authorize: vi.fn(async () => true),
        terminalize,
        feedback,
      }),
    ).resolves.toBe('inactive');

    expect(terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'expired',
        text: 'This permission request is no longer active.',
      }),
    );
    expect(feedback).toHaveBeenCalledWith(
      'This permission request is no longer active.',
    );
  });

  it.each(['provider_terminalization', 'apply_false'] as const)(
    'releases a claimed callback after %s failure and allows one retry',
    async (failure) => {
      const row = permissionRow({
        id: 'interaction-state-machine',
        agent: 'agent-a',
        requestId: 'same-request',
        alias: 'opaque-a',
      });
      const repository = permissionClaimRepository([row]);
      const applyDecision = vi.fn(async () => {
        if (failure === 'apply_throw') throw new Error('apply failed');
        return failure !== 'apply_false';
      });
      const resolve = vi.fn(async (input: any) => {
        if (failure === 'resolve_throw') throw new Error('resolve failed');
        if (failure === 'resolve_false') return false;
        return repository.resolvePendingInteraction({
          idempotencyKey: row.idempotencyKey,
          ...input,
        });
      });
      configurePendingInteractionPermissionCallbacks({
        repository: repository as never,
        applyDecision,
        resolve,
      });
      const scope = {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: 'same-request',
      };
      const firstClaim = await claimPermissionInteractionCallback({
        scope,
        mode: 'allow_once',
        approverRef: 'user:a',
        matchKind: 'individual',
        providerAlias: 'opaque-a',
      });
      expect(firstClaim.status).toBe('claimed');
      if (firstClaim.status !== 'claimed') throw new Error('claim failed');
      expect(repository.prompts[0].claim).toMatchObject({
        id: firstClaim.claim.id,
        scope,
        intent: { mode: 'allow_once', approverRef: 'user:a' },
        match: { providerAliases: ['opaque-a'] },
      });

      let settled = false;
      if (failure === 'provider_terminalization') {
        await expect(
          releasePermissionInteractionCallback({ claim: firstClaim.claim }),
        ).resolves.toBe(true);
      } else {
        settled = await resolveDurablePermissionInteractionByRequestId({
          claim: firstClaim.claim,
        });
      }
      expect(settled).toBe(false);
      expect(row.status).toBe('pending');
      expect(repository.prompts[0]).toMatchObject({
        claim: null,
        settlementState: 'open',
        providerAliases: ['opaque-a'],
      });

      configurePendingInteractionPermissionCallbacks({
        repository: repository as never,
        applyDecision: vi.fn(async () => true),
        resolve: async (input) =>
          repository.resolvePendingInteraction({
            idempotencyKey: row.idempotencyKey,
            ...input,
          }),
      });
      const retry = await claimPermissionInteractionCallback({
        scope,
        mode: 'allow_once',
        approverRef: 'user:a',
        matchKind: 'individual',
        providerAlias: 'opaque-a',
      });
      expect(retry.status).toBe('claimed');
      if (retry.status !== 'claimed') throw new Error('retry claim failed');
      await expect(
        resolveDurablePermissionInteractionByRequestId({ claim: retry.claim }),
      ).resolves.toBe(true);
      expect(row.status).toBe('resolved');
      await expect(
        claimPermissionInteractionCallback({
          scope,
          mode: 'cancel',
          approverRef: 'user:b',
          matchKind: 'individual',
          providerAlias: 'opaque-a',
        }),
      ).resolves.toEqual({ status: 'already_decided' });
    },
  );

  it.each(['apply_throw', 'resolve_false', 'resolve_throw'] as const)(
    'preserves a claimed callback after %s and retries the persisted intent',
    async (failure) => {
      const row = permissionRow({
        id: 'interaction-state-machine',
        agent: 'agent-a',
        requestId: 'same-request',
        alias: 'opaque-a',
      });
      const repository = permissionClaimRepository([row]);
      const applyDecision = vi.fn(async () => {
        if (failure === 'apply_throw') throw new Error('apply failed');
        return true;
      });
      const resolve = vi.fn(async (input: any) => {
        if (failure === 'resolve_throw') throw new Error('resolve failed');
        if (failure === 'resolve_false') return false;
        return repository.resolvePendingInteraction({
          idempotencyKey: row.idempotencyKey,
          ...input,
        });
      });
      configurePendingInteractionPermissionCallbacks({
        repository: repository as never,
        applyDecision,
        resolve,
      });
      const scope = {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: 'same-request',
      };
      const claimed = await claimPermissionInteractionCallback({
        scope,
        mode: 'allow_once',
        approverRef: 'user:a',
        matchKind: 'individual',
        providerAlias: 'opaque-a',
      });
      expect(claimed.status).toBe('claimed');
      if (claimed.status !== 'claimed') throw new Error('claim failed');

      await expect(
        resolveDurablePermissionInteractionByRequestId({
          claim: claimed.claim,
        }),
      ).resolves.toBe(false);
      expect(row.status).toBe('pending');
      expect(repository.prompts[0].claim).toMatchObject({
        id: claimed.claim.id,
        intent: { mode: 'allow_once', approverRef: 'user:a' },
      });
      expect(
        repository.releasePendingPermissionCallback,
      ).not.toHaveBeenCalled();
      await expect(
        claimPermissionInteractionCallback({
          scope,
          mode: 'cancel',
          approverRef: 'user:b',
          matchKind: 'individual',
          providerAlias: 'opaque-a',
        }),
      ).resolves.toEqual({ status: 'already_decided' });

      const retryApply = vi.fn(async (input: any) => {
        expect(input.decision).toMatchObject({
          approved: true,
          mode: 'allow_once',
          decidedBy: 'user:a',
        });
        return true;
      });
      configurePendingInteractionPermissionCallbacks({
        repository: repository as never,
        applyDecision: retryApply,
        resolve: async (input) =>
          repository.resolvePendingInteraction({
            idempotencyKey: row.idempotencyKey,
            ...input,
          }),
      });
      await expect(
        resolveDurablePermissionInteractionByRequestId({
          claim: claimed.claim,
        }),
      ).resolves.toBe(true);
      expect(retryApply).toHaveBeenCalledOnce();
      expect(row.status).toBe('resolved');
    },
  );

  it('retries settlement with the same claim after authority application succeeds', async () => {
    const row = permissionRow({
      id: 'interaction-authority-before-settlement',
      agent: 'agent-a',
      requestId: 'authority-before-settlement',
      alias: 'opaque-authority',
    });
    const repository = permissionClaimRepository([row]);
    const resolvePendingInteraction = repository.resolvePendingInteraction;
    const settleRow = resolvePendingInteraction.getMockImplementation()!;
    resolvePendingInteraction
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementation(settleRow);
    const createTransientGrant = vi.fn(async () => true);
    const durabilityRepository = {
      ...repository,
      resolvePendingInteraction,
      createTransientGrant,
      getActiveRunLease: vi.fn(async () => ({
        runId: 'run-1',
        leaseToken: 'lease-token',
        fencingVersion: 1,
        status: 'active',
      })),
    };
    configurePendingInteractionDurability({
      repository: durabilityRepository as never,
    });
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      interactionId: 'authority-before-settlement',
    };
    const claimed = await claimPermissionInteractionCallback({
      scope,
      mode: 'allow_once',
      approverRef: 'user:a',
      matchKind: 'individual',
      providerAlias: 'opaque-authority',
    });
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('claim failed');

    await expect(
      finishDurablePermissionInteraction({
        request: {
          requestId: 'authority-before-settlement',
          appId: 'default',
          sourceAgentFolder: 'agent-a',
          runId: 'run-1',
          runLeaseToken: 'lease-token',
          runLeaseFencingVersion: 1,
          toolName: 'Bash',
        },
        sourceAgentFolder: 'agent-a',
        decision: {
          approved: true,
          mode: 'allow_once',
          decidedBy: 'user:a',
          decisionClassification: 'user_temporary',
          permissionCallbackClaim: claimed.claim,
        },
      }),
    ).resolves.toBe(true);

    expect(createTransientGrant).toHaveBeenCalledOnce();
    expect(resolvePendingInteraction).toHaveBeenCalledTimes(2);
    expect(repository.releasePendingPermissionCallback).not.toHaveBeenCalled();
    expect(row.status).toBe('resolved');
    await expect(
      claimPermissionInteractionCallback({
        scope,
        mode: 'cancel',
        approverRef: 'user:b',
        matchKind: 'individual',
        providerAlias: 'opaque-authority',
      }),
    ).resolves.toEqual({ status: 'already_decided' });
  });

  it('retries recovered callback settlement without reapplying authority', async () => {
    const row = permissionRow({
      id: 'recovered-callback-resolution-retry',
      agent: 'agent-a',
      requestId: 'recovered-callback-resolution-retry',
      alias: 'opaque-recovered-retry',
    });
    row.runLeaseToken = 'lease-token';
    row.runLeaseFencingVersion = 1;
    Object.assign(row.payload.request, {
      appId: 'default',
      runId: 'run-1',
      runLeaseToken: 'lease-token',
      runLeaseFencingVersion: 1,
    });
    const repository = permissionClaimRepository([row]);
    const resolvePendingInteraction = repository.resolvePendingInteraction;
    const settleRow = resolvePendingInteraction.getMockImplementation()!;
    resolvePendingInteraction
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementation(settleRow);
    const createTransientGrant = vi.fn(async () => true);
    configurePendingInteractionDurability({
      repository: {
        ...repository,
        resolvePendingInteraction,
        createTransientGrant,
        getActiveRunLease: vi.fn(async () => ({
          runId: 'run-1',
          leaseToken: 'lease-token',
          fencingVersion: 1,
          status: 'active',
        })),
      } as never,
    });
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      interactionId: 'recovered-callback-resolution-retry',
    };
    const claimed = await claimPermissionInteractionCallback({
      scope,
      mode: 'allow_once',
      approverRef: 'user:a',
      matchKind: 'individual',
      providerAlias: 'opaque-recovered-retry',
    });
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('claim failed');

    await expect(
      resolveDurablePermissionInteractionByRequestId({ claim: claimed.claim }),
    ).resolves.toBe(true);

    expect(createTransientGrant).toHaveBeenCalledOnce();
    expect(resolvePendingInteraction).toHaveBeenCalledTimes(2);
    expect(row.status).toBe('resolved');
  });

  it('preserves a batch claim when a later member fails settlement', async () => {
    const rows = ['req-1', 'req-2'].map((requestId, index) =>
      permissionRow({
        id: `interaction-batch-${index + 1}`,
        agent: 'agent-a',
        requestId,
        batchId: 'batch-1',
      }),
    );
    const repository = permissionClaimRepository(rows);
    const appliedDecisions: Array<Record<string, unknown>> = [];
    let failSecondSettlement = true;
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async (input: any) => {
        appliedDecisions.push({
          requestId: input.requestId,
          mode: input.decision.mode,
          decidedBy: input.decision.decidedBy,
        });
        return true;
      }),
      resolve: vi.fn(async (input: any) => {
        if (input.requestId === 'req-2' && failSecondSettlement) return false;
        const row = rows.find(
          (candidate) => candidate.payload.requestId === input.requestId,
        );
        return repository.resolvePendingInteraction({
          idempotencyKey: row!.idempotencyKey,
          ...input,
        });
      }),
    });
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      interactionId: 'batch-1',
    };
    const claimed = await claimPermissionInteractionCallback({
      scope,
      mode: 'allow_once',
      approverRef: 'user:a',
      matchKind: 'batch',
    });
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('claim failed');

    await expect(
      resolveDurablePermissionInteractionByRequestId({ claim: claimed.claim }),
    ).resolves.toBe(false);
    expect(rows[0]!.status).toBe('resolved');
    expect(repository.prompts[0].claim).toMatchObject({
      id: claimed.claim.id,
      intent: { mode: 'allow_once', approverRef: 'user:a' },
    });
    expect(repository.releasePendingPermissionCallback).not.toHaveBeenCalled();
    await expect(
      claimPermissionInteractionCallback({
        scope,
        mode: 'cancel',
        approverRef: 'user:b',
        matchKind: 'batch',
      }),
    ).resolves.toEqual({ status: 'already_decided' });

    failSecondSettlement = false;
    await expect(
      resolveDurablePermissionInteractionByRequestId({ claim: claimed.claim }),
    ).resolves.toBe(true);
    expect(rows.every((row) => row.status === 'resolved')).toBe(true);
    expect(appliedDecisions).toEqual([
      { requestId: 'req-1', mode: 'allow_once', decidedBy: 'user:a' },
      { requestId: 'req-2', mode: 'allow_once', decidedBy: 'user:a' },
      { requestId: 'req-2', mode: 'allow_once', decidedBy: 'user:a' },
    ]);
  });

  it('scopes a colliding request id to exactly the authorized agent', async () => {
    const authorized = permissionRow({
      id: 'interaction-agent-a',
      agent: 'agent-a',
      requestId: 'collision',
      alias: 'opaque-collision',
    });
    const other = permissionRow({
      id: 'interaction-agent-b',
      agent: 'agent-b',
      requestId: 'collision',
      alias: 'opaque-collision',
    });
    const repository = permissionClaimRepository([authorized, other]);
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async () => true),
      resolve: async (input) =>
        repository.resolvePendingInteraction({
          idempotencyKey: `default:permission:${input.sourceAgentFolder}:${input.requestId}`,
          ...input,
        }),
    });
    const claim = await claimPermissionInteractionCallback({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: 'collision',
      },
      mode: 'allow_once',
      approverRef: 'user:a',
      matchKind: 'individual',
      providerAlias: 'opaque-collision',
    });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('claim failed');

    await expect(
      resolveDurablePermissionInteractionByRequestId({ claim: claim.claim }),
    ).resolves.toBe(true);
    expect(authorized.status).toBe('resolved');
    expect(other.status).toBe('pending');
    expect(
      repository.prompts.find(
        (prompt) => prompt.sourceAgentFolder === 'agent-b',
      ),
    ).toMatchObject({
      settlementState: 'open',
      providerAliases: ['opaque-collision'],
    });
  });

  it('resumes a persisted claim intent without a second claim CAS', async () => {
    const row = permissionRow({
      id: 'interaction-recovery',
      agent: 'agent-a',
      requestId: 'recover-me',
    });
    const repository = permissionClaimRepository([row]);
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async () => true),
      resolve: async (input) =>
        repository.resolvePendingInteraction({
          idempotencyKey: row.idempotencyKey,
          ...input,
        }),
    });
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      interactionId: 'recover-me',
    };
    const claimed = await claimPermissionInteractionCallback({
      scope,
      mode: 'cancel',
      approverRef: 'system',
      matchKind: 'individual',
    });
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('claim failed');

    const recovered = await findDurablePermissionInteractionByRequestId({
      scope,
    });
    expect(recovered?.claim).toMatchObject({
      id: claimed.claim.id,
      intent: { mode: 'cancel', approverRef: 'system' },
    });
    await expect(
      resolveDurablePermissionInteractionByRequestId({
        claim: claimed.claim,
      }),
    ).resolves.toBe(true);
    expect(repository.claimPendingPermissionCallback).toHaveBeenCalledOnce();
  });

  it('rejects restart rebinding after claim and resumes the persisted intent', async () => {
    const row = permissionRow({
      id: 'interaction-rebind-after-claim',
      agent: 'agent-a',
      requestId: 'rebind-after-claim',
      alias: 'old-provider-alias',
    });
    const repository = permissionClaimRepository([row]);
    configurePendingInteractionDurability({ repository: repository as never });
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async () => true),
      resolve: async (input) =>
        repository.resolvePendingInteraction({
          idempotencyKey: row.idempotencyKey,
          ...input,
        }),
    });
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      interactionId: 'rebind-after-claim',
    };
    const claimed = await claimPermissionInteractionCallback({
      scope,
      mode: 'cancel',
      approverRef: 'system',
      matchKind: 'individual',
      providerAlias: 'old-provider-alias',
    });
    expect(claimed.status).toBe('claimed');
    if (claimed.status !== 'claimed') throw new Error('claim failed');

    await expect(
      bindPendingPermissionInteractionMessage({
        request: row.payload.request,
        decisionOptions: ['allow_once', 'cancel'],
        callbackId: 'new-provider-alias',
        externalMessageId: 'new-inert-prompt',
        provider: 'slack',
        conversationId: 'C123',
      }),
    ).resolves.toBe(false);
    expect(repository.prompts).toHaveLength(1);
    expect(repository.prompts[0]).toMatchObject({
      providerAliases: ['old-provider-alias'],
      externalPromptMessageId: null,
      settlementState: 'claimed',
    });

    const recovered = await findDurablePermissionInteractionByRequestId({
      scope,
    });
    expect(recovered?.claim).toMatchObject({
      id: claimed.claim.id,
      intent: { mode: 'cancel', approverRef: 'system' },
    });
    await expect(
      resolveDurablePermissionInteractionByRequestId({ claim: claimed.claim }),
    ).resolves.toBe(true);
    expect(repository.claimPendingPermissionCallback).toHaveBeenCalledOnce();
  });

  it('leaves a recovered Review-each batch unmutated until callback authorization', async () => {
    const batchId = 'batch:review-each-authorization';
    const rows = [
      permissionRow({
        id: 'review-each-authorization-1',
        agent: 'agent-a',
        requestId: 'req-1',
        batchId,
      }),
      permissionRow({
        id: 'review-each-authorization-2',
        agent: 'agent-a',
        requestId: 'req-2',
        batchId,
      }),
    ];
    const repository = permissionClaimRepository(rows);
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async () => true),
      resolve: vi.fn(async () => true),
    });
    const claimed = await claimPermissionInteractionCallback({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: batchId,
      },
      mode: 'allow_persistent_rule',
      approverRef: 'user:a',
      matchKind: 'batch',
    });
    if (claimed.status !== 'claimed') throw new Error('batch claim failed');

    await expect(
      findDurablePermissionInteractionByRequestId({
        scope: claimed.claim.scope,
      }),
    ).resolves.toMatchObject({
      claim: {
        id: claimed.claim.id,
        intent: {
          mode: 'allow_persistent_rule',
          approverRef: 'user:a',
        },
      },
    });
    expect(repository.expirePendingPermissionReviewEach).not.toHaveBeenCalled();
    expect(repository.prompts[0]).toMatchObject({
      settlementState: 'claimed',
      claim: {
        intent: {
          mode: 'allow_persistent_rule',
          approverRef: 'user:a',
        },
      },
    });
  });

  it('expires recovered Review-each state only after terminalization succeeds', async () => {
    const batchId = 'batch:review-each-terminalization';
    const providerAlias = 'review-each-terminalization-alias';
    const rows = ['req-1', 'req-2'].map((requestId, index) =>
      permissionRow({
        id: `review-each-terminalization-${index + 1}`,
        agent: 'agent-a',
        requestId,
        alias: providerAlias,
        batchId,
      }),
    );
    const repository = permissionClaimRepository(rows);
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async () => true),
      resolve: (input) =>
        repository.resolvePendingInteraction({
          idempotencyKey: `default:permission:agent-a:${input.requestId}`,
          ...input,
        }),
    });
    const scope = {
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      interactionId: batchId,
    };
    const claimed = await claimPermissionInteractionCallback({
      scope,
      mode: 'allow_persistent_rule',
      approverRef: 'user:a',
      matchKind: 'batch',
      providerAlias,
    });
    if (claimed.status !== 'claimed') throw new Error('batch claim failed');
    await repository.settlePendingPermissionCallback({ claim: claimed.claim });

    const terminalize = vi.fn().mockResolvedValueOnce(false);
    const hooks = {
      locator: {
        kind: 'scope' as const,
        scope,
        matchKind: 'batch' as const,
        providerAlias,
      },
      surfaceJid: 'sl:C123',
      incomingMode: 'cancel' as const,
      incomingApprover: 'user:retrying',
      authorize: vi.fn(async () => true),
      terminalize,
      feedback: vi.fn(async () => {}),
    };
    await expect(recoverDurablePermissionDecision(hooks)).resolves.toBe(
      'retryable',
    );
    expect(repository.expirePendingPermissionReviewEach).not.toHaveBeenCalled();
    expect(repository.prompts[0]).toMatchObject({
      settlementState: 'settled',
      claim: { id: claimed.claim.id },
    });
    expect(repository.releasePendingPermissionCallback).not.toHaveBeenCalled();

    terminalize.mockResolvedValueOnce(true);
    await expect(recoverDurablePermissionDecision(hooks)).resolves.toBe(
      'resolved',
    );
    expect(terminalize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          approved: false,
          mode: 'cancel',
          decidedBy: 'system',
        }),
      }),
    );
    expect(repository.expirePendingPermissionReviewEach).toHaveBeenCalledOnce();
    expect(rows.every((row) => row.status === 'cancelled')).toBe(true);
  });

  it('expires and cancels every recovered Review-each member from a batch callback', async () => {
    const batchId = 'batch:review-each-cancel-all';
    const rows = [
      permissionRow({
        id: 'review-each-cancel-all-1',
        agent: 'agent-a',
        requestId: 'req-1',
        batchId,
      }),
      permissionRow({
        id: 'review-each-cancel-all-2',
        agent: 'agent-a',
        requestId: 'req-2',
        batchId,
      }),
    ];
    const repository = permissionClaimRepository(rows);
    const applied: Array<{
      requestId: string;
      mode: string | undefined;
      decidedBy: string | undefined;
    }> = [];
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async ({ requestId, decision }) => {
        applied.push({
          requestId,
          mode: decision.mode,
          decidedBy: decision.decidedBy,
        });
        return true;
      }),
      resolve: async (input) =>
        repository.resolvePendingInteraction({
          idempotencyKey: `default:permission:${input.sourceAgentFolder}:${input.requestId}`,
          ...input,
        }),
    });
    const claimed = await claimPermissionInteractionCallback({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: batchId,
      },
      mode: 'allow_persistent_rule',
      approverRef: 'user:a',
      matchKind: 'batch',
    });
    if (claimed.status !== 'claimed') throw new Error('batch claim failed');
    await repository.settlePendingPermissionCallback({ claim: claimed.claim });

    const recovered = await findDurablePermissionInteractionByRequestId({
      scope: claimed.claim.scope,
    });
    expect(recovered?.claim).toMatchObject({
      id: claimed.claim.id,
      intent: { mode: 'allow_persistent_rule', approverRef: 'user:a' },
      match: { kind: 'batch', canonicalId: batchId },
    });
    const expired = await claimPermissionInteractionCallback({
      scope: claimed.claim.scope,
      mode: 'cancel',
      approverRef: 'user:a',
      matchKind: 'batch',
      expireReviewEach: true,
      recoveredClaim: recovered!.claim!,
    });
    expect(expired).toMatchObject({
      status: 'claimed',
      claim: claimed.claim,
      persistedClaim: {
        intent: { mode: 'cancel', approverRef: 'system' },
      },
    });
    if (expired.status !== 'claimed') throw new Error('expiration failed');

    await expect(
      resolveDurablePermissionInteractionByRequestId({
        claim: expired.claim,
      }),
    ).resolves.toBe(true);
    expect(rows.every((row) => row.status === 'cancelled')).toBe(true);
    expect(applied).toEqual([
      { requestId: 'req-1', mode: 'cancel', decidedBy: 'system' },
      { requestId: 'req-2', mode: 'cancel', decidedBy: 'system' },
    ]);
  });

  it('treats a concurrent recovered Review-each expiration loser as already decided', async () => {
    const batchId = 'batch:review-each-expiration-race';
    const rows = [
      permissionRow({
        id: 'review-each-expiration-race-1',
        agent: 'agent-a',
        requestId: 'req-1',
        batchId,
      }),
      permissionRow({
        id: 'review-each-expiration-race-2',
        agent: 'agent-a',
        requestId: 'req-2',
        batchId,
      }),
    ];
    const repository = permissionClaimRepository(rows);
    const warn = vi.fn();
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision: vi.fn(async () => true),
      resolve: vi.fn(async () => true),
      warn,
    });
    const claimed = await claimPermissionInteractionCallback({
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: batchId,
      },
      mode: 'allow_persistent_rule',
      approverRef: 'user:a',
      matchKind: 'batch',
    });
    if (claimed.status !== 'claimed') throw new Error('batch claim failed');
    const recovered = await findDurablePermissionInteractionByRequestId({
      scope: claimed.claim.scope,
    });

    const results = await Promise.all([
      claimPermissionInteractionCallback({
        scope: claimed.claim.scope,
        mode: 'cancel',
        approverRef: 'user:a',
        matchKind: 'batch',
        expireReviewEach: true,
        recoveredClaim: recovered!.claim!,
      }),
      claimPermissionInteractionCallback({
        scope: claimed.claim.scope,
        mode: 'cancel',
        approverRef: 'user:a',
        matchKind: 'batch',
        expireReviewEach: true,
        recoveredClaim: recovered!.claim!,
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'already_decided',
      'claimed',
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(repository.prompts[0]).toMatchObject({
      settlementState: 'review_each_expired',
      claim: {
        intent: {
          mode: 'allow_persistent_rule',
          approverRef: 'user:a',
        },
      },
    });
  });

  it.each(['active', 'settled'] as const)(
    'expires recovered %s Review-each state into system-cancel claims',
    async (batchState) => {
      const batchId = `batch:review-each-${batchState}`;
      const rows = [
        permissionRow({
          id: `${batchState}-1`,
          agent: 'agent-a',
          requestId: 'req-1',
          batchId,
        }),
        permissionRow({
          id: `${batchState}-2`,
          agent: 'agent-a',
          requestId: 'req-2',
          batchId,
        }),
      ];
      const repository = permissionClaimRepository(rows);
      configurePendingInteractionPermissionCallbacks({
        repository: repository as never,
        applyDecision: vi.fn(async () => true),
        resolve: vi.fn(async () => true),
      });
      const batchClaim = await claimPermissionInteractionCallback({
        scope: {
          appId: 'default',
          sourceAgentFolder: 'agent-a',
          interactionId: batchId,
        },
        mode: 'allow_persistent_rule',
        approverRef: 'user:a',
        matchKind: 'batch',
      });
      if (batchClaim.status !== 'claimed') {
        throw new Error('batch claim failed');
      }
      if (batchState === 'settled') {
        await repository.settlePendingPermissionCallback({
          claim: batchClaim.claim,
        });
      }

      await expect(
        replayPersistedPermissionDecisionForRequest({
          sourceAgentFolder: 'agent-a',
          requestId: 'req-1',
        }),
      ).resolves.toMatchObject({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        permissionCallbackClaim: {
          scope: {
            appId: 'default',
            sourceAgentFolder: 'agent-a',
            interactionId: 'req-1',
          },
        },
      });
      expect(repository.expirePendingPermissionReviewEach).toHaveBeenCalledWith(
        {
          claim: batchClaim.claim,
          now: expect.any(String),
        },
      );
      expect(repository.prompts[0]).toMatchObject({
        settlementState: 'review_each_expired',
        claim: {
          id: batchClaim.claim.id,
          intent: {
            mode: 'allow_persistent_rule',
            approverRef: 'user:a',
          },
        },
      });
    },
  );

  it('keeps an individual member claim ahead of an older settled Review-each batch', async () => {
    const row = permissionRow({
      id: 'settled-batch-rebound-individual',
      agent: 'agent-a',
      requestId: 'req-individual',
    });
    const settledBatchClaim = {
      id: 'settled-batch-claim',
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: 'batch:old:2',
      },
      intent: {
        mode: 'allow_persistent_rule',
        approverRef: 'user:a',
        decidedAt: '2026-07-16T00:00:00.000Z',
      },
      match: {
        kind: 'batch',
        canonicalId: 'batch:old:2',
        providerAliases: [],
      },
    };
    const individualClaim = {
      id: 'individual-member-claim',
      scope: {
        appId: 'default',
        sourceAgentFolder: 'agent-a',
        interactionId: 'req-individual',
      },
      intent: {
        mode: 'allow_once',
        approverRef: 'user:member-approver',
        decidedAt: '2026-07-16T00:01:00.000Z',
      },
      match: {
        kind: 'individual',
        canonicalId: 'req-individual',
        providerAliases: [],
      },
    };
    row.promptFixture.claim = individualClaim;
    row.promptFixture.settlementState = 'settled';
    const repository = permissionClaimRepository([row]);
    repository.prompts[0].parentEnvelopeId = 'settled-batch-parent';
    repository.prompts.unshift({
      ...repository.prompts[0],
      id: 'settled-batch-parent',
      parentEnvelopeId: null,
      interactionId: settledBatchClaim.scope.interactionId,
      matchKind: 'batch',
      memberCount: 2,
      claim: settledBatchClaim,
      settlementState: 'settled',
    });
    const applyDecision = vi.fn(async () => true);
    const resolve = vi.fn(async () => true);
    configurePendingInteractionPermissionCallbacks({
      repository: repository as never,
      applyDecision,
      resolve,
    });

    await expect(
      replayPersistedPermissionDecisionForRequest({
        sourceAgentFolder: 'agent-a',
        requestId: 'req-individual',
      }),
    ).resolves.toMatchObject({
      approved: true,
      mode: 'allow_once',
      decidedBy: 'user:member-approver',
    });
    expect(repository.expirePendingPermissionReviewEach).not.toHaveBeenCalled();
    expect(applyDecision).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('records a colliding live question only in the requested agent scope', async () => {
    const rows = ['agent-a', 'agent-b'].map((sourceAgentFolder) => {
      const request = {
        requestId: 'question-collision',
        sourceAgentFolder,
        targetJid: `tg:${sourceAgentFolder}`,
        questions: [
          {
            question: 'Choose one',
            header: 'Choose one',
            multiSelect: false,
            options: [{ label: sourceAgentFolder, description: '' }],
          },
        ],
      };
      return {
        appId: 'default',
        runId: null,
        kind: 'question',
        status: 'pending',
        payload: {
          requestId: 'question-collision',
          sourceAgentFolder,
          targetJid: `tg:${sourceAgentFolder}`,
          request,
          questionRecoveryEnvelope: questionRecoveryEnvelope(
            request,
            `tg:${sourceAgentFolder}`,
          ),
        } as Record<string, unknown>,
        idempotencyKey: `default:question:${sourceAgentFolder}:question-collision`,
      };
    });
    const repository = {
      ...pendingInteractionLookups(rows),
      updatePendingInteractionPayload: payloadUpdater(rows),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      resolveDurableQuestionInteractionByRequestId({
        requestId: 'question-collision',
        sourceAgentFolder: 'agent-b',
        questionIndex: 0,
        optionIndex: 0,
      }),
    ).resolves.toBe(true);

    expect(repository.updatePendingInteractionPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'default:question:agent-b:question-collision',
      }),
    );
    expect(repository.resolvePendingInteraction).not.toHaveBeenCalled();
    expect(rows[1]!.payload.questionRecoveryEnvelope).toMatchObject({
      completedQuestionIndexes: [0],
    });
  });

  it('leaves a final live answer pending until finish resolves it once with the actor', async () => {
    const request = {
      requestId: 'question-live-final',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      runId: 'run-live-final',
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes', description: '' }],
        },
      ],
    };
    const pending = pendingQuestionRow(request);
    const repository = {
      createPendingInteraction: vi.fn(async (input) => ({
        ...pending,
        id: input.id,
      })),
      ...pendingInteractionLookups([pending]),
      updatePendingInteractionPayload: payloadUpdater([pending]),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });
    await beginDurableQuestionInteraction({
      request,
      sourceAgentFolder: request.sourceAgentFolder,
    });

    await expect(
      resolveDurableQuestionInteractionByRequestId({
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        questionIndex: 0,
        optionIndex: 0,
      }),
    ).resolves.toBe(true);
    expect(repository.resolvePendingInteraction).not.toHaveBeenCalled();

    await expect(
      finishDurableQuestionInteraction({
        request,
        sourceAgentFolder: request.sourceAgentFolder,
        response: {
          requestId: request.requestId,
          answers: { 'Continue?': 'Yes' },
          answeredBy: 'callback-user',
        },
      }),
    ).resolves.toBe(true);
    expect(repository.resolvePendingInteraction).toHaveBeenCalledTimes(1);
    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: { answers: { 'Continue?': 'Yes' } },
        approverRef: 'callback-user',
      }),
    );
  });

  it('records multi-question progress without resolving a continuation', async () => {
    const request = {
      requestId: 'question-live-sequence',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      runId: 'run-live-sequence',
      questions: [
        { question: 'First?', options: [{ label: 'A', description: '' }] },
        { question: 'Second?', options: [{ label: 'B', description: '' }] },
      ],
    };
    const pending = pendingQuestionRow(request);
    const repository = {
      createPendingInteraction: vi.fn(async (input) => ({
        ...pending,
        id: input.id,
      })),
      ...pendingInteractionLookups([pending]),
      updatePendingInteractionPayload: payloadUpdater([pending]),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });
    await beginDurableQuestionInteraction({
      request,
      sourceAgentFolder: request.sourceAgentFolder,
    });

    await expect(
      resolveDurableQuestionInteractionByRequestId({
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        questionIndex: 0,
        optionIndex: 0,
      }),
    ).resolves.toBe(true);
    expect(repository.resolvePendingInteraction).not.toHaveBeenCalled();
    expect(pending.payload.questionRecoveryEnvelope).toMatchObject({
      completedQuestionIndexes: [0],
    });
  });

  it('marks every question represented by a bulk answer object complete', async () => {
    const request = {
      requestId: 'question-bulk-answers',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      questions: [
        { question: 'First?', options: [{ label: 'A', description: '' }] },
        { question: 'Second?', options: [{ label: 'B', description: '' }] },
      ],
    };
    const pending = pendingQuestionRow(request);
    const repository = {
      createPendingInteraction: vi.fn(async () => pending),
      ...pendingInteractionLookups([pending]),
      updatePendingInteractionPayload: payloadUpdater([pending]),
      resolvePendingInteraction: vi.fn(async () => true),
    };
    configurePendingInteractionDurability({ repository: repository as never });

    await expect(
      recordDurableQuestionAnswerProgress({
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        answers: { 'First?': 'A', 'Second?': 'B' },
      }),
    ).resolves.toBe(true);

    expect(pending.payload.questionRecoveryEnvelope).toMatchObject({
      completedQuestionIndexes: [0, 1],
    });
    expect(repository.resolvePendingInteraction).not.toHaveBeenCalled();
  });

  it('rejects duplicate question labels before persistence', async () => {
    const request = {
      requestId: 'question-same-text',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      questions: [
        { question: 'Choose?', options: [{ label: 'A', description: '' }] },
        { question: 'Choose?', options: [{ label: 'B', description: '' }] },
      ],
    };
    const createPendingInteraction = vi.fn();
    const repository = {
      createPendingInteraction,
    };
    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      beginDurableQuestionInteraction({
        request,
        sourceAgentFolder: request.sourceAgentFolder,
      }),
    ).rejects.toThrow(
      'ask_user_question requires unique question text; duplicate question labels are not allowed',
    );
    expect(createPendingInteraction).not.toHaveBeenCalled();
  });

  it('preserves live selection and completion writes through the atomic updater', async () => {
    const request = {
      requestId: 'question-atomic-writers',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      questions: [
        {
          question: 'Choose tools',
          multiSelect: true,
          options: [{ label: 'Browser', description: '' }],
        },
        {
          question: 'Continue?',
          options: [{ label: 'Yes', description: '' }],
        },
      ],
    };
    const pending = {
      appId: 'default',
      kind: 'question',
      status: 'pending',
      idempotencyKey: 'default:question:agent-a:question-atomic-writers',
      payload: {
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        request,
        questionRecoveryEnvelope: questionRecoveryEnvelope(
          request,
          request.targetJid,
        ),
      } as Record<string, unknown>,
    };
    const repository = {
      ...pendingInteractionLookups([pending]),
      updatePendingInteractionPayload: payloadUpdater([pending]),
    };
    configurePendingInteractionDurability({ repository: repository as never });
    await Promise.all([
      resolveDurableQuestionInteractionByRequestId({
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        questionIndex: 0,
        optionIndex: 0,
      }),
      recordDurableQuestionAnswerProgress({
        requestId: request.requestId,
        sourceAgentFolder: request.sourceAgentFolder,
        answers: { 'Continue?': 'Yes' },
        completedQuestionIndexes: [1],
      }),
    ]);

    expect(pending.payload.questionRecoveryEnvelope).toMatchObject({
      selections: [{ questionIndex: 0, optionIndexes: [0] }],
      completedQuestionIndexes: [1],
    });
  });

  it('persists durable multi-select question choices before final resolution', async () => {
    const payload: Record<string, unknown> = {
      requestId: 'question-1',
      sourceAgentFolder: 'agent-folder',
      request: {
        requestId: 'question-1',
        sourceAgentFolder: 'agent-folder',
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
    payload.questionRecoveryEnvelope = questionRecoveryEnvelope(
      payload.request,
      null,
    );
    const pending = {
      id: 'pending-question-1',
      appId: 'default',
      runId: 'run-1',
      kind: 'question',
      status: 'pending',
      payload,
      callbackRoute: null,
      idempotencyKey: 'default:question:agent-folder:question-1',
      approverRef: null,
      resolution: null,
      createdAt: '2026-06-10T00:00:00.000Z',
      expiresAt: '2026-06-11T00:00:00.000Z',
      resolvedAt: null,
    };
    const repository = {
      createPendingInteraction: vi.fn(async () => pending),
      ...pendingInteractionLookups([pending]),
      updatePendingInteractionPayload: payloadUpdater([pending]),
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

    expect(pending.payload.questionRecoveryEnvelope).toMatchObject({
      selections: [{ questionIndex: 0, optionIndexes: [0] }],
    });

    configurePendingInteractionDurability({
      repository: repository as never,
    });

    await expect(
      resolveDurableQuestionInteractionByRequestId({
        requestId: 'question-1',
        questionIndex: 0,
        finalize: true,
      }),
    ).resolves.toBe(true);

    expect(repository.resolvePendingInteraction).not.toHaveBeenCalled();
    await finishDurableQuestionInteraction({
      request: payload.request as never,
      sourceAgentFolder: 'agent-folder',
      response: {
        requestId: 'question-1',
        answers: { 'Choose tools': ['Browser'] },
        answeredBy: 'user:approver',
      },
    });
    expect(repository.resolvePendingInteraction).toHaveBeenCalledWith({
      idempotencyKey: 'default:question:agent-folder:question-1',
      status: 'resolved',
      resolution: { answers: { 'Choose tools': ['Browser'] } },
      approverRef: 'user:approver',
      permissionCallbackClaim: null,
    });
  });

  it('cancels a superseded question lease and reopens the same request for the new lease', async () => {
    const request = {
      requestId: 'question-reask-after-restart',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      runId: 'run-question-reask',
      runLeaseToken: 'test-lease-new',
      runLeaseFencingVersion: 8,
      questions: [
        {
          question: 'Continue?',
          options: [{ label: 'Yes', description: '' }],
        },
      ],
    };
    const oldRequest = {
      ...request,
      runLeaseToken: 'test-lease-old',
      runLeaseFencingVersion: 7,
    };
    const oldPending = pendingQuestionRow(oldRequest);
    let row: any = {
      ...oldPending,
      id: 'question-old-owner',
      runId: oldRequest.runId,
      payload: {
        ...oldPending.payload,
        runLeaseToken: oldRequest.runLeaseToken,
        runLeaseFencingVersion: oldRequest.runLeaseFencingVersion,
      },
    };
    const activeLease = {
      runId: request.runId,
      leaseToken: request.runLeaseToken,
      fencingVersion: request.runLeaseFencingVersion,
    };
    let cancelledRow: any = null;
    const createPendingInteraction = vi.fn(async (input: any) => {
      if (row.status !== 'cancelled') return row;
      row = {
        ...row,
        id: input.id,
        status: 'pending',
        runId: input.runId,
        sourceAgentFolder: input.sourceAgentFolder,
        requestId: input.requestId,
        runLeaseToken: input.runLeaseToken,
        runLeaseFencingVersion: input.runLeaseFencingVersion,
        payload: input.payload,
        callbackRoute: input.callbackRoute,
        resolution: null,
        resolvedAt: null,
      };
      return row;
    });
    const cancelPendingQuestionInteractionIfRunLeaseInactive = vi.fn(
      async (input: any) => {
        if (row.id !== input.id || row.status !== 'pending') return false;
        const owningLeaseIsActive =
          row.runId === activeLease.runId &&
          row.runLeaseToken === activeLease.leaseToken &&
          row.runLeaseFencingVersion === activeLease.fencingVersion;
        if (owningLeaseIsActive) return false;
        cancelledRow = {
          ...row,
          status: 'cancelled',
          resolution: input.resolution,
        };
        row = cancelledRow;
        return true;
      },
    );
    const resolvePendingInteraction = vi.fn(async (input: any) => {
      if (row.status !== 'pending') return false;
      row = {
        ...row,
        status: input.status,
        resolution: input.resolution,
      };
      return true;
    });
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction,
        cancelPendingQuestionInteractionIfRunLeaseInactive,
        resolvePendingInteraction,
      } as never,
    });

    const prompt = vi.fn(async () => ({
      requestId: request.requestId,
      answers: { 'Continue?': 'Yes' },
      answeredBy: 'user:approver',
    }));
    await expect(
      runDurableQuestionInteraction({
        request,
        sourceAgentFolder: request.sourceAgentFolder,
        prompt,
      }),
    ).resolves.toEqual({
      response: {
        requestId: request.requestId,
        answers: { 'Continue?': 'Yes' },
        answeredBy: 'user:approver',
      },
      resolved: true,
    });
    expect(
      cancelPendingQuestionInteractionIfRunLeaseInactive,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'question-old-owner' }),
    );
    expect(cancelledRow).toMatchObject({
      id: 'question-old-owner',
      status: 'cancelled',
      runId: oldRequest.runId,
      runLeaseToken: oldRequest.runLeaseToken,
      runLeaseFencingVersion: oldRequest.runLeaseFencingVersion,
    });
    expect(createPendingInteraction).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenCalledOnce();
    expect(row).toMatchObject({
      status: 'resolved',
      runId: request.runId,
      runLeaseToken: request.runLeaseToken,
      runLeaseFencingVersion: request.runLeaseFencingVersion,
      resolution: { answers: { 'Continue?': 'Yes' } },
    });
    expect(row.id).not.toBe('question-old-owner');
  });

  it('defers a concurrent duplicate while the winning question lease is active', async () => {
    const request = {
      requestId: 'question-live-duplicate',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      runId: 'run-live-duplicate',
      runLeaseToken: 'test-lease-live-duplicate',
      runLeaseFencingVersion: 7,
      questions: [{ question: 'Continue?', options: [] }],
    };
    let row: any = null;
    const createPendingInteraction = vi.fn(async (input: any) => {
      if (!row) {
        row = {
          ...pendingQuestionRow(request),
          id: input.id,
          runId: input.runId,
          sourceAgentFolder: input.sourceAgentFolder,
          requestId: input.requestId,
          runLeaseToken: input.runLeaseToken,
          runLeaseFencingVersion: input.runLeaseFencingVersion,
          payload: input.payload,
          callbackRoute: input.callbackRoute,
        };
      }
      return row;
    });
    const cancelPendingQuestionInteractionIfRunLeaseInactive = vi.fn(
      async () => {
        const ownedByActiveLease =
          row?.status === 'pending' &&
          row.runId === request.runId &&
          row.runLeaseToken === request.runLeaseToken &&
          row.runLeaseFencingVersion === request.runLeaseFencingVersion;
        if (ownedByActiveLease || row?.status !== 'pending') return false;
        row = { ...row, status: 'cancelled' };
        return true;
      },
    );
    const resolvePendingInteraction = vi.fn(async (input: any) => {
      if (row?.status !== 'pending') return false;
      row = {
        ...row,
        status: input.status,
        resolution: input.resolution,
      };
      return true;
    });
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction,
        cancelPendingQuestionInteractionIfRunLeaseInactive,
        resolvePendingInteraction,
      } as never,
    });
    let answerPrompt!: (response: any) => void;
    const promptResponse = new Promise<any>((resolve) => {
      answerPrompt = resolve;
    });
    const prompt = vi.fn(async () => promptResponse);

    const runs = [0, 1].map(() =>
      runDurableQuestionInteraction({
        request,
        sourceAgentFolder: request.sourceAgentFolder,
        prompt,
      }),
    );
    await vi.waitFor(() => {
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(
        cancelPendingQuestionInteractionIfRunLeaseInactive,
      ).toHaveBeenCalledTimes(1);
    });
    expect(row).toMatchObject({ status: 'pending', resolution: null });
    expect(resolvePendingInteraction).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );

    answerPrompt({
      requestId: request.requestId,
      answers: { 'Continue?': 'Yes' },
      answeredBy: 'user:approver',
    });
    const results = await Promise.all(runs);
    expect(results.filter((result) => result.resolved)).toHaveLength(1);
    expect(results.filter((result) => !result.resolved)).toHaveLength(1);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      status: 'resolved',
      resolution: { answers: { 'Continue?': 'Yes' } },
    });
  });

  it('does not reopen or dispatch an already-resolved question', async () => {
    const request = {
      requestId: 'question-already-resolved',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      questions: [{ question: 'Continue?', options: [] }],
    };
    const resolved = {
      ...pendingQuestionRow(request),
      status: 'resolved',
      resolution: { answers: { 'Continue?': 'No' } },
      resolvedAt: '2026-07-17T00:01:00.000Z',
    };
    const resolvePendingInteraction = vi.fn();
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction: vi.fn(async () => resolved),
        resolvePendingInteraction,
      } as never,
    });
    const prompt = vi.fn();

    await expect(
      runDurableQuestionInteraction({
        request,
        sourceAgentFolder: request.sourceAgentFolder,
        prompt,
      }),
    ).resolves.toEqual({
      response: { requestId: request.requestId, answers: {} },
      resolved: false,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(resolvePendingInteraction).not.toHaveBeenCalled();
  });

  it('admits exactly one concurrent re-ask after cancelling a superseded question lease', async () => {
    const request = {
      requestId: 'question-concurrent-reask',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      runId: 'run-concurrent-reask',
      runLeaseToken: 'test-lease-new',
      runLeaseFencingVersion: 8,
      questions: [{ question: 'Continue?', options: [] }],
    };
    const oldRequest = {
      ...request,
      runLeaseToken: 'test-lease-old',
      runLeaseFencingVersion: 7,
    };
    const oldPending = pendingQuestionRow(oldRequest);
    let row: any = {
      ...oldPending,
      id: 'question-concurrent-old-owner',
      runId: oldRequest.runId,
      payload: {
        ...oldPending.payload,
        runLeaseToken: oldRequest.runLeaseToken,
        runLeaseFencingVersion: oldRequest.runLeaseFencingVersion,
      },
    };
    let reopenCount = 0;
    let reopenedId: string | null = null;
    const createPendingInteraction = vi.fn(async (input: any) => {
      if (row.status === 'cancelled') {
        reopenCount += 1;
        reopenedId = input.id;
        row = {
          ...row,
          id: input.id,
          status: 'pending',
          runId: input.runId,
          sourceAgentFolder: input.sourceAgentFolder,
          requestId: input.requestId,
          runLeaseToken: input.runLeaseToken,
          runLeaseFencingVersion: input.runLeaseFencingVersion,
          payload: input.payload,
          callbackRoute: input.callbackRoute,
          resolution: null,
          resolvedAt: null,
        };
      }
      return row;
    });
    const activeLease = {
      runId: request.runId,
      leaseToken: request.runLeaseToken,
      fencingVersion: request.runLeaseFencingVersion,
    };
    const successfulCancelIds: string[] = [];
    const cancelAttemptIds: string[] = [];
    const cancelPendingQuestionInteractionIfRunLeaseInactive = vi.fn(
      async (input: any) => {
        cancelAttemptIds.push(input.id);
        if (row.id !== input.id || row.status !== 'pending') return false;
        const owningLeaseIsActive =
          row.runId === activeLease.runId &&
          row.runLeaseToken === activeLease.leaseToken &&
          row.runLeaseFencingVersion === activeLease.fencingVersion;
        if (owningLeaseIsActive) return false;
        successfulCancelIds.push(input.id);
        row = {
          ...row,
          status: 'cancelled',
          resolution: input.resolution,
        };
        return true;
      },
    );
    const resolvePendingInteraction = vi.fn(async (input: any) => {
      if (row.status !== 'pending') return false;
      row = {
        ...row,
        status: input.status,
        resolution: input.resolution,
      };
      return true;
    });
    configurePendingInteractionDurability({
      repository: {
        createPendingInteraction,
        cancelPendingQuestionInteractionIfRunLeaseInactive,
        resolvePendingInteraction,
      } as never,
    });
    const prompt = vi.fn(async () => ({
      requestId: request.requestId,
      answers: { 'Continue?': 'Yes' },
      answeredBy: 'user:approver',
    }));

    const results = await Promise.all(
      [0, 1].map(() =>
        runDurableQuestionInteraction({
          request,
          sourceAgentFolder: request.sourceAgentFolder,
          prompt,
        }),
      ),
    );

    expect(successfulCancelIds).toEqual(['question-concurrent-old-owner']);
    expect(reopenCount).toBe(1);
    expect(createPendingInteraction).toHaveBeenCalledTimes(3);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.resolved)).toHaveLength(1);
    expect(results.filter((result) => !result.resolved)).toHaveLength(1);
    expect(reopenedId).not.toBeNull();
    expect(reopenedId).not.toBe('question-concurrent-old-owner');
    expect(cancelAttemptIds).not.toContain(reopenedId);
    expect(row).toMatchObject({
      id: reopenedId,
      status: 'resolved',
      runId: request.runId,
      runLeaseToken: request.runLeaseToken,
      runLeaseFencingVersion: request.runLeaseFencingVersion,
      resolution: { answers: { 'Continue?': 'Yes' } },
    });
    expect(resolvePendingInteraction).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it.each([1, 2])(
    'terminalizes and re-asks an orphaned %i-question row',
    async (questionCount) => {
      const request = {
        requestId: `question-restart-${questionCount}`,
        sourceAgentFolder: 'agent-a',
        targetJid: 'sl:C123',
        runId: `run-question-restart-${questionCount}`,
        runLeaseToken: 'test-lease-new',
        runLeaseFencingVersion: 2,
        questions: Array.from({ length: questionCount }, (_, index) => ({
          question: `Question ${index + 1}?`,
          options: [{ label: 'A', description: '' }],
        })),
      };
      const oldRequest = {
        ...request,
        runLeaseToken: 'test-lease-old',
        runLeaseFencingVersion: 1,
      };
      const oldPending = pendingQuestionRow(oldRequest);
      const oldId = `question-restart-old-${questionCount}`;
      let row: any = {
        ...oldPending,
        id: oldId,
        runId: oldRequest.runId,
        payload: {
          ...oldPending.payload,
          runLeaseToken: oldRequest.runLeaseToken,
          runLeaseFencingVersion: oldRequest.runLeaseFencingVersion,
        },
      };
      row.payload.questionRecoveryEnvelope.completedQuestionIndexes = [0];
      const createPendingInteraction = vi.fn(async (input: any) => {
        if (row.status !== 'cancelled') return row;
        row = {
          ...row,
          id: input.id,
          runId: input.runId,
          status: 'pending',
          sourceAgentFolder: input.sourceAgentFolder,
          requestId: input.requestId,
          runLeaseToken: input.runLeaseToken,
          runLeaseFencingVersion: input.runLeaseFencingVersion,
          payload: input.payload,
          callbackRoute: input.callbackRoute,
          resolution: null,
          resolvedAt: null,
        };
        return row;
      });
      let conditionalCancelCount = 0;
      const cancelPendingQuestionInteractionIfRunLeaseInactive = vi.fn(
        async (input: any) => {
          const ownsOldPendingRow =
            input.id === oldId &&
            row.id === oldId &&
            row.status === 'pending' &&
            row.runLeaseToken === oldRequest.runLeaseToken &&
            row.runLeaseFencingVersion === oldRequest.runLeaseFencingVersion;
          if (!ownsOldPendingRow) return false;
          conditionalCancelCount += 1;
          row = {
            ...row,
            status: 'cancelled',
            resolution: input.resolution,
          };
          return true;
        },
      );
      const resolvePendingInteraction = vi.fn();
      configurePendingInteractionDurability({
        repository: {
          createPendingInteraction,
          cancelPendingQuestionInteractionIfRunLeaseInactive,
          resolvePendingInteraction,
        } as never,
      });

      await expect(
        beginDurableQuestionInteraction({
          request,
          sourceAgentFolder: request.sourceAgentFolder,
        }),
      ).resolves.toBe(true);
      expect(conditionalCancelCount).toBe(1);
      expect(
        cancelPendingQuestionInteractionIfRunLeaseInactive,
      ).toHaveBeenCalledOnce();
      expect(createPendingInteraction).toHaveBeenCalledTimes(2);
      expect(row).toMatchObject({
        status: 'pending',
        runId: request.runId,
        runLeaseToken: request.runLeaseToken,
        runLeaseFencingVersion: request.runLeaseFencingVersion,
        payload: {
          questionRecoveryEnvelope: {
            completedQuestionIndexes: [],
          },
        },
        resolution: null,
      });
      expect(row.id).not.toBe(oldId);
      expect(resolvePendingInteraction).not.toHaveBeenCalled();
    },
  );
});
