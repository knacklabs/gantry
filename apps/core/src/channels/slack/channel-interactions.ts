import fs from 'fs';
import path from 'path';

import { App } from '@slack/bolt';

import {
  getSlackPermissionApproverIds,
  PERMISSION_APPROVAL_TIMEOUT_MS,
} from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import {
  formatOutboundForChannel,
  stripInternalTagsPreserveWhitespace,
} from '../../messaging/router.js';
import { resolveGroupFolderPath } from '../../platform/group-folder.js';
import { ChannelOpts } from '../channel-provider.js';
import {
  decisionForMode,
  formatPermissionPromptText as formatSharedPermissionPromptText,
  formatPermissionReceiptText,
  normalizePermissionAction,
} from '../permission-interaction.js';

import { SlackChannelState, SlackMessageLike } from './channel-state.js';

export abstract class SlackChannelInteractions extends SlackChannelState {
  protected async ingestSlackMessage(event: SlackMessageLike): Promise<void> {
    if (!event.channel || !event.ts) return;
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== 'file_share') return;
    if (event.subtype === 'message_changed') return;
    if (event.edited) return;

    const jid = `sl:${event.channel}`;
    const chatName = await this.resolveChannelName(event.channel);

    await this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      chatName,
      'slack',
      this.isLikelyGroupConversation(event.channel),
    );

    const group = this.opts.registeredGroups()[jid];
    const isGroupConversation = this.isLikelyGroupConversation(event.channel);
    if (!group && isGroupConversation) {
      logger.debug(
        { jid, chatName },
        'Message from unregistered Slack conversation',
      );
      return;
    }

    const enriched = await this.enrichMessage(jid, event);
    const content = enriched.text;
    if (!content) return;

    const sender = event.user || 'unknown';
    const senderName = await this.resolveUserName(event.user);

    await this.opts.onMessage(jid, {
      id: event.ts,
      chat_jid: jid,
      provider: 'slack',
      sender,
      sender_name: senderName,
      content,
      timestamp: new Date(Math.round(Number(event.ts) * 1000)).toISOString(),
      is_from_me: this.botUserId ? sender === this.botUserId : false,
      external_message_id: event.ts,
      thread_id: event.thread_ts || undefined,
      attachments: enriched.attachments,
      reply_to_message_id:
        event.thread_ts && event.thread_ts !== event.ts
          ? event.thread_ts
          : undefined,
    });
  }

  protected async tryNativeStreamStart(
    channelId: string,
    threadId: string | undefined,
    text: string,
  ): Promise<string | undefined> {
    if (!this.app) return undefined;
    try {
      const result = (await this.app.client.apiCall('chat.startStream', {
        channel: channelId,
        ...(threadId ? { thread_ts: threadId } : {}),
        markdown_text: text,
      })) as { ok?: boolean; ts?: string; stream_ts?: string };
      if (!result.ok) return undefined;
      return result.stream_ts || result.ts;
    } catch {
      return undefined;
    }
  }

  protected async tryNativeStreamAppend(
    channelId: string,
    streamTs: string,
    text: string,
  ): Promise<boolean> {
    if (!this.app || !text.trim()) return true;
    try {
      const result = (await this.app.client.apiCall('chat.appendStream', {
        channel: channelId,
        ts: streamTs,
        markdown_text: text,
      })) as { ok?: boolean };
      return result.ok === true;
    } catch {
      return false;
    }
  }

  protected async tryNativeStreamStop(
    channelId: string,
    streamTs: string,
  ): Promise<boolean> {
    if (!this.app) return true;
    try {
      const result = (await this.app.client.apiCall('chat.stopStream', {
        channel: channelId,
        ts: streamTs,
      })) as { ok?: boolean };
      return result.ok === true;
    } catch {
      return false;
    }
  }

  protected async canDecidePermission(
    userId: string,
    sourceGroup: string,
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'],
    conversationJid?: string,
  ): Promise<boolean> {
    if (decisionPolicy && decisionPolicy !== 'same_channel') return false;
    if (this.opts.isControlApproverAllowed && conversationJid) {
      return this.opts.isControlApproverAllowed({
        providerId: 'slack',
        conversationJid,
        userId,
        sourceGroup,
        decisionPolicy,
      });
    }
    const allowedIds = getSlackPermissionApproverIds(sourceGroup);
    if (allowedIds.size === 0) return false;
    return allowedIds.has(userId);
  }

  protected formatPermissionPromptText(
    request: PermissionApprovalRequest,
    timeoutMs: number,
  ): string {
    return formatSharedPermissionPromptText(request, timeoutMs);
  }

  protected async resolvePermissionPrompt(
    requestId: string,
    decision: PermissionApprovalDecision,
  ): Promise<void> {
    const pending = this.pendingPermissionPrompts.get(requestId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    this.pendingPermissionPrompts.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
    if (!this.app) return;

    const text = formatPermissionReceiptText(
      requestId,
      pending.request,
      decision,
    );

    try {
      await this.app.client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text,
        blocks: [],
      });
    } catch (err) {
      logger.debug(
        { requestId, err },
        'Failed to update Slack permission approval message',
      );
    }
  }

  protected registerBoltHandlers(): void {
    if (!this.app) return;

    this.app.event('message', async (args: any) => {
      await this.ingestSlackMessage(args.event as SlackMessageLike);
    });

    this.app.event('app_mention', async (args: any) => {
      await this.ingestSlackMessage(args.event as SlackMessageLike);
    });

    this.app.event('app_home_opened', async (args: any) => {
      const event = args.event as { user?: string };
      if (!event.user) return;

      const blocks: Array<Record<string, unknown>> = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*MyClaw Slack Channel*\\nUse threaded replies for best assistant UX.',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Use `myclaw agent add sl:<channel-id>` to bind additional Slack chats.',
          },
        },
      ];

      try {
        await this.app?.client.views.publish({
          user_id: event.user,
          view: {
            type: 'home',
            blocks: blocks as any,
          },
        });
      } catch (err) {
        logger.debug({ err }, 'Failed to publish Slack App Home');
      }
    });

    this.app.shortcut('myclaw_open_home', async (args: any) => {
      await args.ack();
      const triggerId = args.shortcut?.trigger_id as string | undefined;
      if (!triggerId) return;
      try {
        await this.app?.client.views.open({
          trigger_id: triggerId,
          view: {
            type: 'modal',
            title: {
              type: 'plain_text',
              text: 'MyClaw',
            },
            close: {
              type: 'plain_text',
              text: 'Close',
            },
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: 'Use `myclaw agent add sl:<channel-id>` to bind new Slack chats.',
                },
              },
            ],
          },
        });
      } catch (err) {
        logger.debug({ err }, 'Failed to open Slack shortcut modal');
      }
    });

    this.app.shortcut('myclaw_reply_with_context', async (args: any) => {
      await args.ack();
      const shortcut = args.shortcut as {
        channel?: { id?: string };
        message?: { thread_ts?: string; ts?: string };
        user?: { id?: string };
      };
      const channelId = shortcut.channel?.id;
      const userId = shortcut.user?.id;
      if (!channelId || !userId) return;
      try {
        await this.app?.client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: shortcut.message?.thread_ts
            ? 'Reply in this thread to continue with MyClaw context.'
            : 'Start a thread first, then reply to keep context grouped.',
        });
      } catch (err) {
        logger.debug({ err }, 'Failed to respond to Slack message shortcut');
      }
    });

    this.app.action('myclaw_perm_decision', async (args: any) => {
      await args.ack();
      const body = args.body as {
        channel?: { id?: string };
        user?: { id?: string; name?: string; username?: string };
      };
      const action = args.action as { value?: string };
      const userId = body.user?.id || '';
      if (!action.value || !userId) return;

      let payload:
        | {
            requestId: string;
            decision: string;
          }
        | undefined;
      try {
        payload = JSON.parse(action.value) as {
          requestId: string;
          decision: string;
        };
      } catch {
        return;
      }
      if (!payload?.requestId) return;
      const mode = normalizePermissionAction(payload.decision);
      if (!mode) return;

      const pending = this.pendingPermissionPrompts.get(payload.requestId);
      if (!pending) return;
      if (
        pending.decisionPolicy === 'same_channel' &&
        body.channel?.id !== pending.channelId
      ) {
        try {
          await this.app?.client.chat.postEphemeral({
            channel: body.channel?.id || pending.channelId,
            user: userId,
            text: 'This approval request belongs to a different chat.',
          });
        } catch {
          // ignore
        }
        return;
      }

      if (
        !(await this.canDecidePermission(
          userId,
          pending.sourceGroup,
          pending.decisionPolicy,
          pending.approvalContextJid || `sl:${pending.channelId}`,
        ))
      ) {
        try {
          await this.app?.client.chat.postEphemeral({
            channel: pending.channelId,
            user: userId,
            text: 'You are not allowed to decide this permission request.',
          });
        } catch {
          // ignore
        }
        return;
      }

      const decidedBy =
        body.user?.name || body.user?.username || body.user?.id || 'unknown';
      const decision = decisionForMode(pending.request, mode, decidedBy);
      await this.resolvePermissionPrompt(payload.requestId, {
        ...decision,
      });
    });

    this.app.action('myclaw_userq_select', async (args: any) => {
      await args.ack();
      const action = args.action as { value?: string };
      const body = args.body as {
        channel?: { id?: string };
        user?: { id?: string; name?: string; username?: string };
      };
      const parsed = this.parseUserQuestionActionValue(action.value);
      if (!parsed || parsed.optionIndex === undefined) return;

      const key = this.pendingUserQuestionKey(
        parsed.requestId,
        parsed.questionIndex,
      );
      const pending = this.pendingUserQuestions.get(key);
      if (!pending || pending.settled) return;
      const callbackChannelId = body.channel?.id || '';
      if (!callbackChannelId || callbackChannelId !== pending.channelId) return;
      const userId = body.user?.id || '';
      if (!userId) return;
      if (
        !(await this.canDecidePermission(
          userId,
          pending.sourceGroup,
          undefined,
          `sl:${pending.channelId}`,
        ))
      ) {
        try {
          await this.app?.client.chat.postEphemeral({
            channel: pending.channelId,
            user: userId,
            text: 'You are not allowed to answer this prompt.',
          });
        } catch {
          // ignore
        }
        return;
      }
      if (
        parsed.optionIndex < 0 ||
        parsed.optionIndex >= pending.question.options.length
      ) {
        return;
      }

      const answeredBy =
        body.user?.name || body.user?.username || body.user?.id || 'unknown';
      if (!pending.question.multiSelect) {
        const label =
          pending.question.options[parsed.optionIndex]?.label?.trim() || '';
        await this.finalizeUserQuestionPrompt(pending, label, answeredBy);
        return;
      }

      if (pending.selectedOptionIndexes.has(parsed.optionIndex)) {
        pending.selectedOptionIndexes.delete(parsed.optionIndex);
      } else {
        pending.selectedOptionIndexes.add(parsed.optionIndex);
      }
      await this.refreshUserQuestionPrompt(pending);
    });

    this.app.action('myclaw_userq_done', async (args: any) => {
      await args.ack();
      const action = args.action as { value?: string };
      const body = args.body as {
        channel?: { id?: string };
        user?: { id?: string; name?: string; username?: string };
      };
      const parsed = this.parseUserQuestionActionValue(action.value);
      if (!parsed) return;

      const key = this.pendingUserQuestionKey(
        parsed.requestId,
        parsed.questionIndex,
      );
      const pending = this.pendingUserQuestions.get(key);
      if (!pending || pending.settled || !pending.question.multiSelect) return;
      const callbackChannelId = body.channel?.id || '';
      if (!callbackChannelId || callbackChannelId !== pending.channelId) return;
      const userId = body.user?.id || '';
      if (!userId) return;
      if (
        !(await this.canDecidePermission(
          userId,
          pending.sourceGroup,
          undefined,
          `sl:${pending.channelId}`,
        ))
      ) {
        try {
          await this.app?.client.chat.postEphemeral({
            channel: pending.channelId,
            user: userId,
            text: 'You are not allowed to answer this prompt.',
          });
        } catch {
          // ignore
        }
        return;
      }

      const selectedLabels = Array.from(pending.selectedOptionIndexes)
        .sort((a, b) => a - b)
        .map((index) => pending.question.options[index]?.label || '')
        .map((label) => label.trim())
        .filter((label) => label.length > 0)
        .slice(0, pending.question.options.length);
      const answeredBy =
        body.user?.name || body.user?.username || body.user?.id || 'unknown';
      await this.finalizeUserQuestionPrompt(
        pending,
        selectedLabels,
        answeredBy,
      );
    });
  }
}
