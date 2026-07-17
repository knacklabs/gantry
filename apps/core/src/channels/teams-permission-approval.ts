import {
  bindPendingPermissionInteractionMessage,
  DurableInteractionPersistenceError,
} from '../application/interactions/pending-interaction-durability.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { incrementOperationalError } from '../shared/operational-error-counters.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import { buildTeamsApprovalAdaptiveCard } from './teams-cards.js';
import { permissionDecisionOptions } from './permission-interaction.js';
import { bindTeamsPermissionPromptMessage } from './teams-prompt-binding.js';
import {
  teamsConversationIdFromJid,
  type PendingTeamsPermissionPrompt,
  type TeamsSdkClient,
} from './teams-types.js';

export async function requestTeamsPermissionApproval(input: {
  connected: boolean;
  jid: string;
  request: PermissionApprovalRequest;
  onPromptDelivered?: (messageId: string) => void;
  sdkClient: TeamsSdkClient;
  pendingPermissionPrompts: Map<string, PendingTeamsPermissionPrompt>;
  settleTimeout: (
    providerAlias: string,
  ) => Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
}): Promise<PermissionApprovalDecision> {
  if (!input.connected) {
    return { approved: false, reason: 'Teams channel is not connected' };
  }
  const conversationId = teamsConversationIdFromJid(input.jid);
  if (!conversationId) {
    return {
      approved: false,
      reason: 'This Teams conversation could not be identified.',
    };
  }
  if (!input.sdkClient.sendAdaptiveCard) {
    return {
      approved: false,
      reason:
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
      approved: false,
      reason: 'This approval request is already awaiting a decision.',
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
  const timeoutPermissionPrompt = async (): Promise<void> => {
    let result = await input.settleTimeout(callback.providerAlias);
    if (result === 'settled') return;
    if (result === 'already_decided') return;
    if (result === 'retryable') {
      const firstDelay = Math.floor(PERMISSION_APPROVAL_TIMEOUT_MS / 3);
      for (const delayMs of [
        firstDelay,
        PERMISSION_APPROVAL_TIMEOUT_MS - firstDelay,
      ]) {
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
    const sent = await input.sdkClient.sendAdaptiveCard({
      conversationId,
      card: buildTeamsApprovalAdaptiveCard(approvalRequest, callback),
      ...(input.request.threadId ? { threadId: input.request.threadId } : {}),
    });
    const messageId = sent.externalMessageId;
    const decision = new Promise<PermissionApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        void timeoutPermissionPrompt();
      }, PERMISSION_APPROVAL_TIMEOUT_MS);
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
      return await decision;
    }
    if (messageId) input.onPromptDelivered?.(messageId);
    return await decision;
  } catch (err) {
    if (err instanceof DurableInteractionPersistenceError) {
      logger.error(
        { jid: input.jid, requestId: input.request.requestId, err },
        'Failed to send Teams permission prompt',
      );
      throw err;
    }
    incrementOperationalError('channels', 'permission_prompt');
    logger.error(
      { jid: input.jid, requestId: input.request.requestId, err },
      'Failed to send Teams permission prompt',
    );
    return {
      approved: false,
      reason: 'Failed to send approval prompt to Teams',
    };
  }
}
