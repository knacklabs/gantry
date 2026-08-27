import type { App } from '@slack/bolt';
import type {
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionApprovalResult,
} from '../../domain/types.js';
import type { PreparedPermissionCardSend } from '../../domain/permission-card.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { incrementOperationalError } from '../../shared/operational-error-counters.js';
import { resolveInteractionSettlementDelayMs } from '../interaction-settlement.js';
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
import {
  buildBoundedPermissionCard,
  permissionCardCallback,
} from '../permission-card.js';

export function prepareSlackPermissionCardSend(input: {
  app: App;
  channelId: string;
  approverUserIds: readonly string[];
  options: MessageSendOptions & {
    permissionCardView: NonNullable<MessageSendOptions['permissionCardView']>;
  };
}): PreparedPermissionCardSend {
  if ([...new Set(input.approverUserIds)].filter(Boolean).length === 0) {
    throw new Error(
      'This Slack conversation has no configured approvers for permission cards.',
    );
  }
  const view = input.options.permissionCardView;
  const callback = permissionCardCallback(view);
  const card = buildBoundedPermissionCard(view);
  const actions = {
    type: 'actions',
    elements: [
      ...(card.fullViewAvailable
        ? [
            {
              type: 'button',
              action_id: 'gantry_perm_full_view',
              text: {
                type: 'plain_text',
                text: card.parts.fullView?.label ?? 'View details',
              },
              value: JSON.stringify({ callback }),
            },
          ]
        : []),
      ...permissionDecisionOptions(view.request).map((mode) => ({
        type: 'button',
        action_id: slackPermissionDecisionActionId(mode),
        text: {
          type: 'plain_text',
          text: permissionButtonLabel(mode, view.request),
        },
        ...(mode === 'cancel'
          ? { style: 'danger' as const }
          : { style: 'primary' as const }),
        value: JSON.stringify({ callback, decision: mode }),
      })),
    ],
  };
  const threadTs = slackThreadTsFromThreadId(input.options.threadId);
  return {
    send: async () => {
      const sent = (await input.app.client.chat.postMessage({
        channel: input.channelId,
        text: card.text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        blocks: [
          ...buildPermissionPromptContentBlocks(card.parts),
          actions,
        ] as any,
      })) as { ts?: string; message_ts?: string };
      const messageId = sent.ts || sent.message_ts;
      if (!messageId) {
        throw new Error('Slack did not return a permission card id.');
      }
      return {
        delivery: { externalMessageId: messageId },
        locator: {
          provider: 'slack',
          conversationId: input.channelId,
          messageId,
          ...(input.options.threadId
            ? { threadId: input.options.threadId }
            : {}),
        },
      };
    },
  };
}

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
  timeoutPermissionPrompt: (
    providerAlias: string,
    retryWindowMs: number,
  ) => Promise<void>;
  onPromptDelivered?: (messageId: string) => void;
}): Promise<PermissionApprovalResult> {
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
  const userIds = [...new Set(input.approverUserIds || [])].filter(Boolean);
  const visiblePromptText =
    'Approval required from a configured approver. Only configured approvers can decide this action.';
  const visiblePromptBlocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Approval required*\nA configured approver must decide this action.',
      },
    },
    actionsBlock,
  ];
  const postVisiblePrompt = async (): Promise<{ ts?: string } | null> => {
    const sent = (await input.app.client.chat.postMessage({
      channel: input.channelId,
      text: visiblePromptText,
      ...threadPayload,
      blocks: visiblePromptBlocks as any,
    })) as { ts?: string; message_ts?: string };
    return { ts: sent.ts || sent.message_ts };
  };
  const postPrivateDetails = async (blocks: unknown[]): Promise<void> => {
    for (const user of userIds) {
      try {
        await input.app.client.chat.postEphemeral({
          channel: input.channelId,
          user,
          text: promptText,
          ...threadPayload,
          blocks: blocks as any,
        });
      } catch (err) {
        logger.warn(
          { jid: input.jid, requestId: input.request.requestId, user, err },
          'Slack ephemeral permission prompt failed for approver',
        );
      }
    }
  };
  let transmissionBegan = false;
  try {
    if (userIds.length === 0) {
      const reason =
        'Approval prompt could not be shown because this Slack conversation has no configured approvers. Add at least one conversation approver and retry.';
      return {
        kind: 'delivery_failure',
        code: 'surface_unsupported',
        retryable: true,
        delivered: 'no',
        userMessage: reason,
      };
    }
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
      transmissionBegan = true;
      response = await postVisiblePrompt();
    } catch (blocksErr) {
      logger.warn(
        { jid: input.jid, requestId: input.request.requestId, err: blocksErr },
        'Slack visible permission prompt could not be delivered',
      );
      const reason =
        'Approval prompt could not be posted to this Slack thread. Check that the Slack app can post messages here and retry.';
      throw blocksErr;
    }
    const messageTs = response?.ts;
    if (!messageTs) {
      const reason = 'Slack did not accept the approval prompt.';
      return {
        kind: 'delivery_failure',
        code: 'provider_failed',
        retryable: false,
        delivered: 'unknown',
        userMessage: reason,
      };
    }
    let resolveDecision!: (decision: PermissionApprovalDecision) => void;
    const decision = new Promise<PermissionApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const { expiresAt } = input.request as PermissionApprovalRequest & {
      expiresAt?: unknown;
    };
    const settlementDelayMs = resolveInteractionSettlementDelayMs({
      expiresAt,
      isPermissionRequest: true,
      jobId: input.request.jobId,
      permissionLane: input.request.permissionLane,
      fallbackTimeoutMs: input.timeoutMs,
    });
    const timer =
      settlementDelayMs !== undefined
        ? setTimeout(() => {
            void input.timeoutPermissionPrompt(
              callback.providerAlias,
              settlementDelayMs,
            );
          }, settlementDelayMs)
        : undefined;
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
      // Post-send persistence failures become delivered:'unknown' (0128
      // transmission boundary, review R7): the card may be live, so this
      // must never be retried into a duplicate.
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
      }
      logger.error(
        { jid: input.jid, requestId: input.request.requestId, err },
        'Failed to send Slack permission prompt',
      );
      return {
        kind: 'delivery_failure',
        code: 'provider_failed',
        retryable: false,
        delivered: 'unknown',
        userMessage: 'Failed to send approval prompt to Slack',
      };
    }
    input.onPromptDelivered?.(messageTs);
    // Ephemeral details preserve the richer prompt for active approvers, but the
    // durable thread card above is the sole required action surface.
    await postPrivateDetails(contentBlocks);
    return { kind: 'decision', decision: await decision };
  } catch (err) {
    if (err instanceof DurableInteractionPersistenceError) throw err;
    incrementOperationalError('channels', 'permission_prompt');
    logger.error(
      { jid: input.jid, requestId: input.request.requestId, err },
      'Failed to send Slack permission prompt',
    );
    return {
      kind: 'delivery_failure',
      code: 'provider_failed',
      retryable: !transmissionBegan,
      delivered: transmissionBegan ? 'unknown' : 'no',
      userMessage: 'Failed to send approval prompt to Slack',
    };
  }
}
