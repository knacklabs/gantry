import type { App } from '@slack/bolt';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  buildPermissionPromptParts,
  permissionButtonLabel,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import { buildPermissionPromptContentBlocks } from './permission-blocks.js';
import { slackPermissionDecisionActionId } from './permission-action-id.js';
import type { PendingPermissionPrompt } from './channel-state.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';

export async function requestSlackPermissionApproval(input: {
  app: App;
  jid: string;
  channelId: string;
  request: PermissionApprovalRequest;
  timeoutMs: number;
  promptText: string;
  pendingPermissionPrompts: Map<string, PendingPermissionPrompt>;
  resolvePermissionPrompt: (
    requestId: string,
    decision: PermissionApprovalDecision,
  ) => Promise<void>;
}): Promise<PermissionApprovalDecision> {
  const contentBlocks = buildPermissionPromptContentBlocks(
    buildPermissionPromptParts(input.request, input.timeoutMs),
  );
  const actionsBlock = {
    type: 'actions',
    elements: permissionDecisionOptions(input.request).map((mode) => ({
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
        requestId: input.request.requestId,
        decision: mode,
      }),
    })),
  };
  const threadTs = slackThreadTsFromThreadId(input.request.threadId);
  const threadPayload = threadTs ? { thread_ts: threadTs } : {};
  const postPrompt = (blocks: unknown[]) =>
    input.app.client.chat.postMessage({
      channel: input.channelId,
      text: input.promptText,
      ...threadPayload,
      blocks: blocks as any,
    }) as Promise<{ ts?: string }>;

  try {
    let response: { ts?: string };
    try {
      response = await postPrompt([...contentBlocks, actionsBlock]);
    } catch (blocksErr) {
      logger.warn(
        { jid: input.jid, requestId: input.request.requestId, err: blocksErr },
        'Slack native permission blocks rejected; retrying with simple layout',
      );
      response = await postPrompt([
        {
          type: 'section',
          text: { type: 'mrkdwn', text: input.promptText },
        },
        actionsBlock,
      ]);
    }
    const messageTs = response.ts;
    if (!messageTs) {
      return {
        approved: false,
        reason: 'Slack did not accept the approval prompt.',
      };
    }

    return await new Promise<PermissionApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        void input.resolvePermissionPrompt(input.request.requestId, {
          approved: false,
          decidedBy: 'system',
          reason: 'timed out',
        });
      }, input.timeoutMs);

      input.pendingPermissionPrompts.set(input.request.requestId, {
        channelId: input.channelId,
        sourceAgentFolder: input.request.sourceAgentFolder,
        decisionPolicy: input.request.decisionPolicy,
        approvalContextJid: input.request.approvalContextJid,
        request: input.request,
        messageTs,
        timer,
        resolve,
        settled: false,
      });
    });
  } catch (err) {
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
