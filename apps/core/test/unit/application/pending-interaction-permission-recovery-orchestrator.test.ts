import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  learnRememberedDecision,
  type PermissionRememberContext,
} from '@core/application/permissions/human-decision-learning.js';
import { HumanDecisionMemoryService } from '@core/application/permissions/human-decision-memory-service.js';
import type { DurablePermissionInteractionContext } from '@core/application/interactions/pending-interaction-permission-callback.js';
import { recoverDurablePermissionDecision } from '@core/application/interactions/pending-interaction-permission-recovery-orchestrator.js';
import { formatPermissionReceiptText } from '@core/channels/permission-interaction.js';
import {
  HumanDecisionOutcome,
  HumanDecisionScope,
} from '@core/domain/human-decision.js';
import { PermissionLane } from '@core/domain/permission-lane.js';
import type { PermissionCardAffordances } from '@core/domain/permission-card-affordances.js';
import type {
  PermissionApprovalRequest,
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
} from '@core/domain/types.js';
import { inMemoryDecisionMemory } from '../runtime/askfloor-tap-budget-harness.js';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  findByRequestId: vi.fn(),
  findByPromptMessage: vi.fn(),
  release: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock(
  '@core/application/interactions/pending-interaction-permission-callback.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    claimPermissionInteractionCallback: mocks.claim,
    findDurablePermissionInteractionByRequestId: mocks.findByRequestId,
    releasePermissionInteractionCallback: mocks.release,
    resolveDurablePermissionInteractionByRequestId: mocks.resolve,
  }),
);

vi.mock(
  '@core/application/interactions/pending-interaction-prompt-binding.js',
  () => ({
    findDurablePermissionInteractionByPromptMessage: mocks.findByPromptMessage,
  }),
);

const scope = {
  appId: 'default',
  sourceAgentFolder: 'agent-a',
  interactionId: 'durable-callback-id',
};

const claim: PermissionCallbackClaimReference = {
  id: 'claim-id',
  scope,
};

const rememberedAffordances: PermissionCardAffordances = {
  eligible: true,
  offered: ['remember_allow_exact'],
  destructive: false,
  protected: false,
  preTapLines: [
    'Allow will remember: this exact action',
    'No will remember: this exact action.',
  ],
  postTapLines: {
    remember_allow_exact:
      'Remembered: this exact action. Change it any time with /permissions.',
  },
};

function durable(
  request: PermissionApprovalRequest,
): DurablePermissionInteractionContext {
  return {
    scope,
    requestId: scope.interactionId,
    batchCallbackId: null,
    sourceAgentFolder: scope.sourceAgentFolder,
    targetJid: 'sl:C123',
    approvalContextJid: 'sl:C123',
    threadId: null,
    decisionPolicy: 'same_channel',
    decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
    externalPromptMessageId: null,
    externalPromptProvider: null,
    externalPromptConversationId: null,
    externalPromptThreadId: null,
    providerAliases: ['provider-alias'],
    request,
  };
}

describe('pending interaction permission recovery orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue({ status: 'claimed', claim });
    mocks.resolve.mockResolvedValue(true);
  });

  afterEach(async () => {
    const actual = await vi.importActual<
      typeof import('@core/application/interactions/pending-interaction-permission-callback.js')
    >(
      '@core/application/interactions/pending-interaction-permission-callback.js',
    );
    actual.configurePendingInteractionPermissionCallbacks(null);
  });

  it('permission recovery applies the decision to the original immutable request', async () => {
    const request: PermissionApprovalRequest = Object.freeze({
      requestId: 'member-request-id',
      sourceAgentFolder: scope.sourceAgentFolder,
      targetJid: 'sl:C123',
      toolName: 'Bash',
      decisionOptions: ['allow_once', 'cancel'],
    });
    mocks.findByRequestId.mockResolvedValue(durable(request));
    const terminalize = vi.fn(async () => true);

    await expect(
      recoverDurablePermissionDecision({
        locator: {
          kind: 'scope',
          scope,
          matchKind: 'batch',
          providerAlias: 'provider-alias',
        },
        surfaceJid: 'sl:C123',
        incomingMode: 'allow_persistent_rule',
        incomingApprover: 'user:approver',
        authorize: vi.fn(async () => true),
        terminalize,
        feedback: vi.fn(async () => {}),
      }),
    ).resolves.toBe('resolved');

    expect(terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        request,
        decision: expect.objectContaining({
          approved: false,
          mode: 'cancel',
          decidedBy: 'system',
        }),
      }),
    );
    expect(mocks.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        matchKind: 'batch',
        mode: 'allow_persistent_rule',
      }),
    );
    expect(mocks.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      terminalize.mock.invocationCallOrder[0]!,
    );
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('recovers a persisted remember code into the identical mode and remember intent and learns once from the persisted context before applying, rejects an unauthorized tapper before the claim with no write and no application, settles an authorized code on an ineligible card as its scalar base once with no write, treats a replayed callback on a settled claim as already decided, learns on recovery after a crash before learning, and ends with one active row after a crash after learning', async () => {
    const actual = await vi.importActual<
      typeof import('@core/application/interactions/pending-interaction-permission-callback.js')
    >(
      '@core/application/interactions/pending-interaction-permission-callback.js',
    );
    const request: PermissionApprovalRequest = {
      requestId: 'remembered-request',
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      toolName: 'Bash',
      toolInput: { command: 'git log' },
      cardAffordances: rememberedAffordances,
    };
    const persistedClaim: PermissionCallbackClaim = {
      ...claim,
      intent: {
        mode: 'remember_allow_exact',
        approverRef: 'person-one',
        decidedAt: '2026-09-07T00:00:00.000Z',
      },
      match: {
        kind: 'individual',
        canonicalId: scope.interactionId,
        providerAliases: [],
      },
    };
    const rememberContext = (eligible: boolean): PermissionRememberContext => ({
      eligible,
      laneInput: { permissionMode: 'auto' },
      lane: PermissionLane.InteractiveAuto,
      appId: 'default',
      agentFolder: 'agent-a',
      canonicalTool: 'Bash',
      personId: 'person-one',
      effectHash: 'effect-one',
      effectSchemaVersion: 3,
      railVersion: 7,
      kindVariant: 'category',
      candidates: {
        deny: { ok: true, scopeKey: 'deny-one', pathOnly: false },
        exact: { ok: true, scopeKey: 'exact-one', pathOnly: false },
        kind: { ok: true, scopeKey: 'kind-one', pathOnly: false },
        kindTool: { ok: true, scopeKey: 'kind-tool-one', pathOnly: false },
        place: { ok: false, reason: 'no_root' },
      },
    });
    const group = {
      prompt: {
        id: 'prompt-one',
        parentEnvelopeId: null,
        appId: 'default',
        jobId: null,
        setupFingerprint: null,
        sourceAgentFolder: 'agent-a',
        interactionId: scope.interactionId,
        matchKind: 'individual',
        memberCount: 1,
        envelope: {
          version: 1,
          renderedDecisionOptions: ['remember_allow_exact'],
          targetJid: 'sl:C123',
          approvalContextJid: 'sl:C123',
          threadId: null,
          decisionPolicy: null,
          renderedRequest: request,
        },
        fullView: null,
        externalPromptProvider: null,
        externalPromptConversationId: null,
        externalPromptMessageId: null,
        externalPromptThreadId: null,
        providerAliases: [],
        claim: persistedClaim,
        settlementState: 'claimed',
        settledAt: null,
        createdAt: '2026-09-07T00:00:00.000Z',
        updatedAt: '2026-09-07T00:00:00.000Z',
      },
      members: [
        {
          id: 'member-one',
          appId: 'default',
          runId: null,
          sourceAgentFolder: 'agent-a',
          requestId: request.requestId,
          runLeaseToken: null,
          runLeaseFencingVersion: null,
          envelopeId: 'prompt-one',
          memberIndex: 0,
          kind: 'permission',
          status: 'pending',
          payload: { request, rememberContext: rememberContext(true) },
          callbackRoute: null,
          idempotencyKey: 'default:permission:agent-a:remembered-request',
          approverRef: null,
          resolution: null,
          createdAt: '2026-09-07T00:00:00.000Z',
          expiresAt: '2026-09-08T00:00:00.000Z',
          resolvedAt: null,
        },
      ],
    } as const;
    const rows = [];
    const service = new HumanDecisionMemoryService({
      repository: inMemoryDecisionMemory(rows),
    });
    const order: string[] = [];
    const settlements: unknown[] = [];
    const applyDecision = vi.fn(async () => {
      order.push('apply');
      return true;
    });
    let resolutionSucceeds = true;
    actual.configurePendingInteractionPermissionCallbacks({
      repository: {
        findPendingPermissionPrompt: vi.fn(async () => group),
        releasePendingPermissionCallback: vi.fn(async () => true),
      } as never,
      learn: async (currentClaim) => {
        order.push('learn');
        const settlement =
          await actual.rememberSettlementForClaim(currentClaim);
        settlements.push(settlement);
        if (settlement?.resolution.remember) {
          await learnRememberedDecision({
            context: settlement.context,
            resolution: settlement.resolution.remember,
            service,
            warn: vi.fn(),
          });
        }
      },
      applyDecision,
      resolve: vi.fn(async () => resolutionSucceeds),
    });
    mocks.findByRequestId.mockResolvedValue({
      ...durable(request),
      claim: persistedClaim,
      decisionOptions: ['remember_allow_exact'],
    });
    mocks.claim.mockResolvedValue({
      status: 'claimed',
      claim,
      persistedClaim,
    });
    mocks.resolve.mockImplementation((input) =>
      actual.resolveDurablePermissionInteractionByRequestId(input),
    );
    const terminalize = vi.fn(async () => true);
    const recover = (authorize = true) =>
      recoverDurablePermissionDecision({
        locator: {
          kind: 'scope',
          scope,
          matchKind: 'individual',
        },
        surfaceJid: 'sl:C123',
        incomingMode: 'remember_allow_exact',
        incomingApprover: 'person-one',
        authorize: vi.fn(async () => authorize),
        terminalize,
        feedback: vi.fn(async () => undefined),
      });

    await expect(recover()).resolves.toBe('resolved');
    expect(order).toEqual(['learn', 'apply']);
    expect(settlements[0]).toMatchObject({
      resolution: {
        mode: 'allow_once',
        remember: {
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Exact,
        },
      },
    });
    expect(terminalize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({
          approved: true,
          mode: 'allow_once',
        }),
      }),
    );
    expect(rows).toHaveLength(1);

    mocks.claim.mockClear();
    const applicationsBeforeUnauthorized = applyDecision.mock.calls.length;
    await expect(recover(false)).resolves.toBe('unauthorized');
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(applyDecision).toHaveBeenCalledTimes(applicationsBeforeUnauthorized);

    rows.splice(0);
    group.members[0].payload.rememberContext = rememberContext(false);
    await expect(recover()).resolves.toBe('resolved');
    expect(rows).toHaveLength(0);
    expect(terminalize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ mode: 'allow_once' }),
      }),
    );

    mocks.resolve.mockClear();
    mocks.claim.mockResolvedValueOnce({ status: 'already_decided' });
    await expect(recover()).resolves.toBe('resolved');
    expect(mocks.resolve).not.toHaveBeenCalled();

    group.members[0].payload.rememberContext = rememberContext(true);
    mocks.resolve
      .mockRejectedValueOnce(new Error('crash before learning'))
      .mockImplementation((input) =>
        actual.resolveDurablePermissionInteractionByRequestId(input),
      );
    await expect(recover()).rejects.toThrow('crash before learning');
    expect(rows).toHaveLength(0);
    await expect(recover()).resolves.toBe('resolved');
    expect(rows).toHaveLength(1);

    rows.splice(0);
    resolutionSucceeds = false;
    await expect(recover()).resolves.toBe('retryable');
    expect(rows).toHaveLength(1);
    resolutionSucceeds = true;
    await expect(recover()).resolves.toBe('resolved');
    expect(rows).toHaveLength(1);
  });

  it('replays the persisted card affordances on recovery converts a remember code outside the offered set to its scalar base before applying and learning and yields the remembered receipt for an offered code and the once-only receipt otherwise', async () => {
    const actual = await vi.importActual<
      typeof import('@core/application/interactions/pending-interaction-permission-callback.js')
    >(
      '@core/application/interactions/pending-interaction-permission-callback.js',
    );
    const request: PermissionApprovalRequest = {
      requestId: 'replayed-affordances',
      appId: 'default',
      sourceAgentFolder: 'agent-a',
      targetJid: 'sl:C123',
      toolName: 'Bash',
      toolInput: { command: 'git log' },
      cardAffordances: rememberedAffordances,
    };
    const persistedClaim: PermissionCallbackClaim = {
      ...claim,
      intent: {
        mode: 'remember_allow_exact',
        approverRef: 'person-one',
        decidedAt: '2026-09-08T00:00:00.000Z',
      },
      match: {
        kind: 'individual',
        canonicalId: scope.interactionId,
        providerAliases: [],
      },
    };
    const group = {
      prompt: {
        claim: persistedClaim,
        matchKind: 'individual',
        settlementState: 'claimed',
      },
      members: [
        {
          sourceAgentFolder: scope.sourceAgentFolder,
          requestId: request.requestId,
          runId: null,
          runLeaseToken: null,
          runLeaseFencingVersion: null,
          payload: {
            request,
            rememberContext: {
              eligible: true,
              laneInput: { permissionMode: 'auto' },
              lane: PermissionLane.InteractiveAuto,
              appId: 'default',
              agentFolder: 'agent-a',
              canonicalTool: 'Bash',
              personId: 'person-one',
              effectHash: 'effect-one',
              effectSchemaVersion: 3,
              railVersion: 7,
              kindVariant: 'category',
              candidates: {
                deny: { ok: true, scopeKey: 'deny-one', pathOnly: false },
                exact: { ok: true, scopeKey: 'exact-one', pathOnly: false },
                kind: { ok: true, scopeKey: 'kind-one', pathOnly: false },
                kindTool: {
                  ok: true,
                  scopeKey: 'kind-tool-one',
                  pathOnly: false,
                },
                place: { ok: false, reason: 'no_root' },
              },
            },
          },
        },
      ],
    };
    const order: string[] = [];
    const learnedRemember = vi.fn();
    actual.configurePendingInteractionPermissionCallbacks({
      repository: {
        findPendingPermissionPrompt: vi.fn(async () => group),
        releasePendingPermissionCallback: vi.fn(async () => true),
      } as never,
      learn: async (currentClaim) => {
        order.push('learn');
        learnedRemember(
          (await actual.rememberSettlementForClaim(currentClaim))?.resolution
            .remember,
        );
      },
      applyDecision: vi.fn(async () => {
        order.push('apply');
        return true;
      }),
      resolve: vi.fn(async () => true),
    });
    mocks.findByRequestId.mockResolvedValue({
      ...durable(request),
      claim: persistedClaim,
      decisionOptions: ['remember_allow_exact'],
    });
    mocks.claim.mockResolvedValue({
      status: 'claimed',
      claim,
      persistedClaim,
    });
    mocks.resolve.mockImplementation((input) =>
      actual.resolveDurablePermissionInteractionByRequestId(input),
    );
    const receipts: string[] = [];
    const recover = () =>
      recoverDurablePermissionDecision({
        locator: { kind: 'scope', scope, matchKind: 'individual' },
        surfaceJid: 'sl:C123',
        incomingMode: 'remember_allow_exact',
        incomingApprover: 'person-one',
        authorize: vi.fn(async () => true),
        terminalize: vi.fn(async (receipt) => {
          if (receipt.status === 'resolved') {
            expect(receipt.request.cardAffordances).toEqual(
              request.cardAffordances,
            );
            receipts.push(
              formatPermissionReceiptText(
                receipt.request.requestId,
                receipt.request,
                receipt.decision,
              ),
            );
          }
          return true;
        }),
        feedback: vi.fn(async () => undefined),
      });

    await expect(recover()).resolves.toBe('resolved');
    request.cardAffordances = {
      ...rememberedAffordances,
      offered: [],
      postTapLines: {},
    };
    await expect(recover()).resolves.toBe('resolved');

    expect(order).toEqual(['learn', 'apply', 'learn', 'apply']);
    expect(learnedRemember.mock.calls).toEqual([
      [
        {
          kind: 'remember',
          outcome: HumanDecisionOutcome.Allow,
          scope: HumanDecisionScope.Exact,
        },
      ],
      [undefined],
    ]);
    expect(receipts).toEqual([
      'Remembered: this exact action. Change it any time with /permissions.',
      'Approved for this run only: Command (git log).',
    ]);
  });
});
