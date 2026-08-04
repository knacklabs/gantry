import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DurablePermissionInteractionContext } from '@core/application/interactions/pending-interaction-permission-callback.js';
import { recoverDurablePermissionDecision } from '@core/application/interactions/pending-interaction-permission-recovery-orchestrator.js';
import type {
  PermissionApprovalRequest,
  PermissionCallbackClaimReference,
} from '@core/domain/types.js';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  findByRequestId: vi.fn(),
  findByPromptMessage: vi.fn(),
  release: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock(
  '@core/application/interactions/pending-interaction-permission-callback.js',
  () => ({
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

function durable(
  request: PermissionApprovalRequest | null,
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
  } as DurablePermissionInteractionContext;
}

describe('pending interaction permission recovery orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue({ status: 'claimed', claim });
    mocks.resolve.mockResolvedValue(true);
  });

  it('resolves a recovered legacy permission without a request snapshot using a generic receipt', async () => {
    mocks.findByRequestId.mockResolvedValue(durable(null));
    const terminalize = vi.fn(async () => true);

    await expect(
      recoverDurablePermissionDecision({
        locator: {
          kind: 'scope',
          scope,
          matchKind: 'individual',
          providerAlias: 'provider-alias',
        },
        surfaceJid: 'sl:C123',
        incomingMode: 'allow_once',
        incomingApprover: 'user:approver',
        authorize: vi.fn(async () => true),
        terminalize,
        feedback: vi.fn(async () => {}),
      }),
    ).resolves.toBe('resolved');

    expect(terminalize).toHaveBeenCalledWith({
      status: 'resolved',
      request: null,
      decision: {
        approved: true,
        mode: 'allow_once',
        decidedBy: 'user:approver',
        permissionCallbackClaim: claim,
      },
      context: expect.objectContaining({ request: null }),
      text: 'Permission allowed.',
    });
  });

  it('terminalizes a recovered Review-each batch as cancelled', async () => {
    mocks.findByRequestId.mockResolvedValue(
      durable({
        requestId: 'member-request-id',
        sourceAgentFolder: scope.sourceAgentFolder,
        targetJid: 'sl:C123',
        toolName: 'Bash',
        decisionOptions: ['allow_once', 'cancel'],
      }),
    );
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
  });
});
