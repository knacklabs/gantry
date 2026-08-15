import {
  bindPendingPermissionInteractionMessage,
  DurableInteractionPersistenceError,
} from '../application/interactions/pending-interaction-durability.js';
import type {
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionApprovalResult,
} from '../domain/types.js';
import type { PreparedPermissionCardSend } from '../domain/permission-card.js';
import { logger } from '../infrastructure/logging/logger.js';
import { incrementOperationalError } from '../shared/operational-error-counters.js';
import { resolveInteractionSettlementDelayMs } from './interaction-settlement.js';
import { buildTeamsApprovalAdaptiveCard } from './teams-cards.js';
import { permissionDecisionOptions } from './permission-interaction.js';
import { bindTeamsPermissionPromptMessage } from './teams-prompt-binding.js';
import {
  teamsConversationIdFromJid,
  type PendingTeamsPermissionPrompt,
  type TeamsSdkClient,
} from './teams-types.js';
import {
  buildBoundedPermissionCard,
  permissionCardCallback,
} from './permission-card.js';

export function prepareTeamsPermissionCardSend(input: {
  connected: boolean;
  jid: string;
  options: MessageSendOptions & {
    permissionCardView: NonNullable<MessageSendOptions['permissionCardView']>;
  };
  sdkClient: TeamsSdkClient;
}): PreparedPermissionCardSend {
  if (!input.connected) throw new Error('Teams channel is not connected');
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) {
    throw new Error('This Teams conversation could not be identified.');
  }
  if (!input.sdkClient.sendAdaptiveCard) {
    throw new Error(
      'This Teams conversation cannot display approval cards right now.',
    );
  }
  const view = input.options.permissionCardView;
  const card = buildBoundedPermissionCard(view);
  const callback = permissionCardCallback(view);
  const adaptiveCard = buildTeamsApprovalAdaptiveCard(
    view.request,
    callback as never,
  );
  adaptiveCard.body = adaptiveCard.body.map((block, index) =>
    index === 1 ? { ...block, text: card.text } : block,
  );
  if (card.parts.fullView) {
    adaptiveCard.actions.unshift({
      type: 'Action.ShowCard',
      title: card.parts.fullView.label,
      card: {
        type: 'AdaptiveCard',
        version: '1.5',
        body: [
          {
            type: 'TextBlock',
            text: card.parts.fullView.content,
            wrap: true,
          },
        ],
      },
    } as never);
  }
  const sdkClient = input.sdkClient;
  return {
    send: async () => {
      const sent = await sdkClient.sendAdaptiveCard!({
        conversationId,
        card: adaptiveCard,
        ...(input.options.threadId ? { threadId: input.options.threadId } : {}),
      });
      const messageId = sent.externalMessageId;
      if (!messageId) {
        throw new Error('Teams did not return a permission card id.');
      }
      return {
        delivery: { externalMessageId: messageId },
        locator: {
          provider: 'teams',
          conversationId,
          messageId,
          ...(input.options.threadId
            ? { threadId: input.options.threadId }
            : {}),
        },
      };
    },
  };
}

export async function requestTeamsPermissionApproval(input: {
  connected: boolean;
  jid: string;
  request: PermissionApprovalRequest;
  timeoutMs: number;
  onPromptDelivered?: (messageId: string) => void;
  sdkClient: TeamsSdkClient;
  pendingPermissionPrompts: Map<string, PendingTeamsPermissionPrompt>;
  settleTimeout: (
    providerAlias: string,
  ) => Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
}): Promise<PermissionApprovalResult> {
  if (!input.connected) {
    return {
      kind: 'delivery_failure',
      code: 'surface_unsupported',
      retryable: true,
      delivered: 'no',
      userMessage: 'Teams channel is not connected',
    };
  }
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) {
    return {
      kind: 'delivery_failure',
      code: 'target_missing',
      retryable: true,
      delivered: 'no',
      userMessage: 'This Teams conversation could not be identified.',
    };
  }
  if (!input.sdkClient.sendAdaptiveCard) {
    return {
      kind: 'delivery_failure',
      code: 'surface_unsupported',
      retryable: true,
      delivered: 'no',
      userMessage:
        'This Teams conversation cannot display approval cards right now.',
    };
  }
  if (
    Array.from(input.pendingPermissionPrompts.values()).some(
      (pending) =>
        pending.request.requestId === input.request.requestId &&
        (pending.request.appId || 'default') ===
          (input.request.appId || 'default') &&
        pending.sourceAgentFolder === input.request.sourceAgentFolder,
    )
  ) {
    return {
      kind: 'delivery_failure',
      code: 'surface_unsupported',
      retryable: true,
      delivered: 'no',
      userMessage: 'This approval request is already awaiting a decision.',
    };
  }

  const approvalRequest = {
    ...input.request,
    targetJid: input.request.targetJid ?? input.jid,
  };
  const callback = {
    providerAlias: globalThis.crypto.randomUUID(),
    scope: {
      appId: approvalRequest.appId || 'default',
      sourceAgentFolder: approvalRequest.sourceAgentFolder,
      interactionId: approvalRequest.requestId,
    },
    matchKind: approvalRequest.permissionBatch
      ? ('batch' as const)
      : ('individual' as const),
  };
  let settlementDelayMs: number | undefined;
  const timeoutPermissionPrompt = async (): Promise<void> => {
    let result = await input.settleTimeout(callback.providerAlias);
    if (result === 'settled') return;
    if (result === 'already_decided') return;
    if (result === 'retryable') {
      const retryWindowMs = settlementDelayMs ?? 0;
      const firstDelay = Math.floor(retryWindowMs / 3);
      for (const delayMs of [firstDelay, retryWindowMs - firstDelay]) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
        if (!input.pendingPermissionPrompts.has(callback.providerAlias)) return;
        result = await input.settleTimeout(callback.providerAlias);
        if (result !== 'retryable') break;
      }
    }
    if (result === 'already_decided') return;
    const pending = input.pendingPermissionPrompts.get(callback.providerAlias);
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    input.pendingPermissionPrompts.delete(callback.providerAlias);
    pending.resolve({
      approved: false,
      mode: 'cancel',
      decidedBy: 'system',
      reason: 'timed out',
    });
  };
  let transmissionBegan = false;
  try {
    if (
      !(await bindPendingPermissionInteractionMessage({
        request: approvalRequest,
        decisionOptions: permissionDecisionOptions(approvalRequest),
        callbackId: callback.providerAlias,
        provider: 'teams',
        conversationId,
      }))
    ) {
      throw new Error('Teams permission callback binding failed');
    }
    transmissionBegan = true;
    const sent = await input.sdkClient.sendAdaptiveCard({
      conversationId,
      card: buildTeamsApprovalAdaptiveCard(approvalRequest, callback),
      ...(input.request.threadId ? { threadId: input.request.threadId } : {}),
    });
    const messageId = sent.externalMessageId;
    const decision = new Promise<PermissionApprovalDecision>((resolve) => {
      const { expiresAt } = input.request as PermissionApprovalRequest & {
        expiresAt?: unknown;
      };
      settlementDelayMs = resolveInteractionSettlementDelayMs({
        expiresAt,
        permissionLane: input.request.permissionLane,
        fallbackTimeoutMs: input.timeoutMs,
      });
      let timer!: ReturnType<typeof setTimeout>;
      if (settlementDelayMs !== undefined) {
        timer = setTimeout(() => {
          void timeoutPermissionPrompt();
        }, settlementDelayMs);
        timer.unref?.();
      }
      input.pendingPermissionPrompts.set(callback.providerAlias, {
        callback,
        conversationId,
        messageId,
        sourceAgentFolder: input.request.sourceAgentFolder,
        decisionPolicy: input.request.decisionPolicy,
        approvalContextJid: input.request.approvalContextJid,
        request: approvalRequest,
        threadId: input.request.threadId,
        timer,
        resolve,
        settled: false,
      });
    });
    const bound = await bindTeamsPermissionPromptMessage(
      approvalRequest,
      conversationId,
      callback.providerAlias,
      messageId,
    );
    if (!bound) {
      const pending = input.pendingPermissionPrompts.get(
        callback.providerAlias,
      );
      if (pending) {
        pending.settled = true;
        clearTimeout(pending.timer);
        input.pendingPermissionPrompts.delete(callback.providerAlias);
        pending.resolve({
          approved: false,
          reason: 'This permission request was already decided.',
        });
      }
      return {
        kind: 'delivery_failure',
        code: 'provider_failed',
        retryable: false,
        delivered: 'unknown',
        userMessage: 'Failed to bind Teams approval prompt',
      };
    }
    if (messageId) input.onPromptDelivered?.(messageId);
    return { kind: 'decision', decision: await decision };
  } catch (err) {
    // Pre-transmission persistence failures propagate (the durable lane
    // owns that retry); post-send ones become delivered:'unknown' below
    // (0128 transmission boundary, review R7).
    if (
      err instanceof DurableInteractionPersistenceError &&
      !transmissionBegan
    ) {
      logger.error(
        { jid: input.jid, requestId: input.request.requestId, err },
        'Failed to send Teams permission prompt',
      );
      throw err;
    }
    const stale = input.pendingPermissionPrompts.get(callback.providerAlias);
    if (stale && !stale.settled) {
      stale.settled = true;
      clearTimeout(stale.timer);
      input.pendingPermissionPrompts.delete(callback.providerAlias);
    }
    incrementOperationalError('channels', 'permission_prompt');
    logger.error(
      { jid: input.jid, requestId: input.request.requestId, err },
      'Failed to send Teams permission prompt',
    );
    return {
      kind: 'delivery_failure',
      code: 'provider_failed',
      retryable: !transmissionBegan,
      delivered: transmissionBegan ? 'unknown' : 'no',
      userMessage: 'Failed to send approval prompt to Teams',
    };
  }
}
