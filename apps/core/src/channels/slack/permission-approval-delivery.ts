import type { App } from '@slack/bolt';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { incrementOperationalError } from '../../shared/operational-error-counters.js';
import {
  buildPermissionPromptParts,
  formatPermissionPromptPartsText,
  permissionButtonLabel,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import {
  bindPendingPermissionInteractionMessage,
  DurableInteractionPersistenceError,
} from '../../application/interactions/pending-interaction-durability.js';
import { buildPermissionPromptContentBlocks } from './permission-blocks.js';
import { slackPermissionDecisionActionId } from './permission-action-id.js';
import type { PendingPermissionPrompt } from './channel-state.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';
import type { ChannelOpts } from '../channel-provider.js';

export function slackPermissionApproverIds(
  runtimeSettings: ChannelOpts['runtimeSettings'],
  providerAccountId: string | undefined,
  channelId: string,
): string[] {
  try {
    const conversations = Object.values(
      runtimeSettings?.().conversations || {},
    );
    return [
      ...new Set(
        conversations.flatMap((conversation) =>
          conversation.externalId === channelId &&
          (conversation.providerAccount ?? conversation.providerConnection) ===
            providerAccountId
            ? conversation.controlApprovers
            : [],
        ),
      ),
    ];
  } catch {
    return [];
  }
}

export async function requestSlackPermissionApproval(input: {
  app: App;
  jid: string;
  channelId: string;
  request: PermissionApprovalRequest;
  timeoutMs: number;
  approverUserIds?: readonly string[];
  pendingPermissionPrompts: Map<string, PendingPermissionPrompt>;
  timeoutPermissionPrompt: (providerAlias: string) => Promise<void>;
  onPromptDelivered?: (messageId: string) => void;
}): Promise<PermissionApprovalDecision> {
  const parts = buildPermissionPromptParts(input.request, input.timeoutMs);
  const decisionOptions = permissionDecisionOptions(input.request);
  const callback = {
    providerAlias: globalThis.crypto.randomUUID(),
    scope: {
      appId: input.request.appId || 'default',
      sourceAgentFolder: input.request.sourceAgentFolder,
      interactionId: input.request.requestId,
    },
    matchKind: input.request.permissionBatch
      ? ('batch' as const)
      : ('individual' as const),
  };
  const contentBlocks = buildPermissionPromptContentBlocks(parts);
  const promptText = formatPermissionPromptPartsText(parts);
  const actionsBlock = {
    type: 'actions',
    elements: [
      ...(parts.fullView
        ? [
            {
              type: 'button',
              action_id: 'gantry_perm_full_view',
              text: {
                type: 'plain_text',
                text: parts.fullView.label,
              },
              value: JSON.stringify({
                callback,
                ...(input.request.providerAccountId
                  ? { providerAccountId: input.request.providerAccountId }
                  : {}),
              }),
            },
          ]
        : []),
      ...decisionOptions.map((mode) => ({
        type: 'button',
        action_id: slackPermissionDecisionActionId(mode),
        text: {
          type: 'plain_text',
          text: permissionButtonLabel(mode, input.request),
        },
        ...(mode === 'cancel'
          ? { style: 'danger' as const }
          : { style: 'primary' as const }),
        value: JSON.stringify({
          callback,
          decision: mode,
          ...(input.request.providerAccountId
            ? { providerAccountId: input.request.providerAccountId }
            : {}),
        }),
      })),
    ],
  };
  const threadTs = slackThreadTsFromThreadId(input.request.threadId);
  const threadPayload = threadTs ? { thread_ts: threadTs } : {};
  const postPrivatePrompt = async (
    blocks: unknown[],
  ): Promise<{ ts?: string } | null> => {
    const userIds = [...new Set(input.approverUserIds || [])].filter(Boolean);
    let first: { ts?: string } | null = null;
    let lastError: unknown;
    for (const user of userIds) {
      try {
        const sent = (await input.app.client.chat.postEphemeral({
          channel: input.channelId,
          user,
          text: promptText,
          ...threadPayload,
          blocks: blocks as any,
        })) as { ts?: string; message_ts?: string };
        first ||= { ts: sent.ts || sent.message_ts };
      } catch (err) {
        lastError = err;
        logger.debug(
          { jid: input.jid, requestId: input.request.requestId, user, err },
          'Slack ephemeral permission prompt failed for approver',
        );
      }
    }
    if (!first && lastError) throw lastError;
    return first;
  };
  try {
    const binding = {
      request: input.request,
      decisionOptions,
      callbackId: callback.providerAlias,
      provider: 'slack',
      conversationId: input.channelId,
      fullView: parts.fullView,
    };
    if (!(await bindPendingPermissionInteractionMessage(binding))) {
      throw new Error('Slack permission callback binding failed');
    }
    let response: { ts?: string } | null;
    try {
      response = await postPrivatePrompt([...contentBlocks, actionsBlock]);
    } catch (blocksErr) {
      logger.warn(
        { jid: input.jid, requestId: input.request.requestId, err: blocksErr },
        'Slack native permission blocks rejected; retrying with simple layout',
      );
      const simpleBlocks = [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: promptText },
        },
        actionsBlock,
      ];
      response = await postPrivatePrompt(simpleBlocks);
    }
    const messageTs = response?.ts;
    if (!messageTs) {
      return {
        approved: false,
        reason: 'Slack did not accept the approval prompt.',
      };
    }
    let resolveDecision!: (decision: PermissionApprovalDecision) => void;
    const decision = new Promise<PermissionApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const timer = setTimeout(() => {
      void input.timeoutPermissionPrompt(callback.providerAlias);
    }, input.timeoutMs);
    const livePending: PendingPermissionPrompt = {
      callback,
      channelId: input.channelId,
      sourceAgentFolder: input.request.sourceAgentFolder,
      decisionPolicy: input.request.decisionPolicy,
      approvalContextJid: input.request.approvalContextJid,
      request: input.request,
      messageTs,
      timer,
      resolve: resolveDecision,
      settled: false,
    };
    input.pendingPermissionPrompts.set(callback.providerAlias, livePending);
    try {
      const bound = await bindPendingPermissionInteractionMessage({
        ...binding,
        externalMessageId: messageTs,
      });
      if (!bound) throw new Error('Slack permission message binding failed');
    } catch (err) {
      if (err instanceof DurableInteractionPersistenceError) throw err;
      incrementOperationalError('channels', 'permission_prompt');
      if (!livePending.settled) {
        livePending.settled = true;
        clearTimeout(timer);
        if (
          input.pendingPermissionPrompts.get(callback.providerAlias) ===
          livePending
        ) {
          input.pendingPermissionPrompts.delete(callback.providerAlias);
        }
        resolveDecision({
          approved: false,
          reason: 'Failed to send approval prompt to Slack',
        });
      }
      logger.error(
        { jid: input.jid, requestId: input.request.requestId, err },
        'Failed to send Slack permission prompt',
      );
      return await decision;
    }
    input.onPromptDelivered?.(messageTs);
    return await decision;
  } catch (err) {
    if (err instanceof DurableInteractionPersistenceError) throw err;
    incrementOperationalError('channels', 'permission_prompt');
    logger.error(
      { jid: input.jid, requestId: input.request.requestId, err },
      'Failed to send Slack permission prompt',
    );
    return {
      approved: false,
      reason: 'Failed to send approval prompt to Slack',
    };
  }
}
