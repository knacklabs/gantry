import { logger } from '../../infrastructure/logging/logger.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import {
  findDurablePermissionInteractionByRequestId,
  findDurableQuestionInteractionByRequestId,
  resolveDurablePermissionInteractionByRequestId,
  resolveDurableQuestionInteractionByRequestId,
} from '../../application/interactions/pending-interaction-durability.js';
import {
  decisionForMode,
  formatPermissionPromptText as formatSharedPermissionPromptText,
  formatPermissionReceiptText,
  normalizePermissionAction,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import { SlackChannelState, SlackMessageLike } from './channel-state.js';
import { buildPermissionReceiptBlocks } from './permission-blocks.js';
import {
  buildTriggerPattern,
  triggerForRoute,
} from '../../shared/trigger-pattern.js';
import {
  SLACK_NATIVE_APPEND_MAX_LENGTH,
  splitSlackTextByCodeUnits,
} from './text-limits.js';
import { SLACK_PERMISSION_DECISION_ACTION_IDS } from './permission-action-id.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  tryNativeStreamAppend,
  tryNativeStreamStart,
  tryNativeStreamStop,
} from './native-stream.js';
import { registerSlackMessageActionHandler } from './channel-message-action-handler.js';
import { registerSlackUtilityHandlers } from './channel-utility-handlers.js';

export abstract class SlackChannelInteractions extends SlackChannelState {
  protected async ingestSlackSlashCommand(command: {
    channel_id?: string;
    user_id?: string;
    user_name?: string;
    text?: string;
    trigger_id?: string;
    command_id?: string;
  }): Promise<void> {
    const channelId = command.channel_id;
    if (!channelId) return;
    const jid = `sl:${channelId}`;
    const chatName = await this.resolveChannelName(channelId);
    await this.opts.onChatMetadata(
      jid,
      nowIso(),
      chatName,
      'slack',
      this.isLikelyGroupConversation(channelId),
    );
    const group = this.opts.conversationRoutes()[jid];
    if (!group && this.isLikelyGroupConversation(channelId)) return;
    const text = command.text?.trim();
    const content = text ? `/gantry ${text}` : '/gantry';
    const id =
      command.command_id ||
      command.trigger_id ||
      `gantry:${channelId}:${Date.now()}`;
    await this.opts.onMessage(jid, {
      id,
      chat_jid: jid,
      provider: 'slack',
      sender: command.user_id || 'unknown',
      sender_name:
        (command.user_id
          ? await this.resolveUserName(command.user_id)
          : command.user_name) ||
        command.user_name ||
        command.user_id ||
        'unknown',
      content,
      timestamp: nowIso(),
      is_from_me: false,
      external_message_id: id,
    });
  }

  protected async ingestSlackMessage(
    event: SlackMessageLike,
    options: { forceOwnedTopLevel?: boolean } = {},
  ): Promise<void> {
    if (!event.channel || !event.ts) return;
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== 'file_share') return;
    if (event.subtype === 'message_changed') return;
    if (event.edited) return;
    const jid = `sl:${event.channel}`;
    const chatName = await this.resolveChannelName(event.channel);
    await this.opts.onChatMetadata(
      jid,
      nowIso(),
      chatName,
      'slack',
      this.isLikelyGroupConversation(event.channel),
    );
    const group = this.opts.conversationRoutes()[jid];
    const isGroupConversation = this.isLikelyGroupConversation(event.channel);
    if (!group && isGroupConversation) {
      logger.debug(
        { jid, chatName },
        'Message from unregistered Slack conversation',
      );
      return;
    }
    const enriched = await this.enrichMessage(jid, event);
    const rawContent = enriched.text;
    const content =
      this.botUserId && group
        ? rawContent.replace(
            new RegExp(`^<@${this.botUserId}>\\s+`),
            `${triggerForRoute(group)} `,
          )
        : rawContent;
    if (!content) return;
    const sender = event.user || 'unknown';
    const senderName = await this.resolveUserName(event.user);
    const ownsTopLevelMessage =
      Boolean(group) &&
      (options.forceOwnedTopLevel ||
        group.requiresTrigger === false ||
        buildTriggerPattern(triggerForRoute(group)).test(content.trim()));
    const threadId =
      event.thread_ts ||
      (isGroupConversation && ownsTopLevelMessage ? event.ts : undefined);
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
      thread_id: threadId,
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
    return tryNativeStreamStart({ app: this.app, channelId, threadId, text });
  }
  protected async tryNativeStreamAppend(
    channelId: string,
    streamTs: string,
    text: string,
  ): Promise<{ completed: boolean; sentPrefix: string }> {
    return tryNativeStreamAppend({ app: this.app, channelId, streamTs, text });
  }
  protected async tryNativeStreamStop(
    channelId: string,
    streamTs: string,
  ): Promise<boolean> {
    return tryNativeStreamStop({ app: this.app, channelId, streamTs });
  }
  protected async canDecidePermission(
    userId: string,
    sourceAgentFolder: string,
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'],
    conversationJid?: string,
  ): Promise<boolean> {
    if (decisionPolicy && decisionPolicy !== 'same_channel') return false;
    if (this.opts.isControlApproverAllowed && conversationJid) {
      return this.opts.isControlApproverAllowed({
        providerId: 'slack',
        conversationJid,
        userId,
        sourceAgentFolder,
        decisionPolicy,
      });
    }
    return false;
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
        blocks: buildPermissionReceiptBlocks(text) as any,
      });
    } catch (err) {
      logger.debug(
        { requestId, err },
        'Failed to update Slack permission approval message',
      );
    }
  }
  protected registerBoltHandlers(options: { inbound?: boolean } = {}): void {
    if (!this.app) return;
    if (options.inbound !== false) {
      this.app.event('message', async (args: any) => {
        await this.ingestSlackMessage(args.event as SlackMessageLike);
      });
      this.app.event('app_mention', async (args: any) => {
        await this.ingestSlackMessage(args.event as SlackMessageLike, {
          forceOwnedTopLevel: true,
        });
      });
      this.app.command('/gantry', async (args: any) => {
        await args.ack();
        await this.ingestSlackSlashCommand(args.command || args.body || {});
      });
      registerSlackUtilityHandlers(this.app);
    }
    const handlePermissionDecision = async (args: any) => {
      await args.ack();
      const body = args.body as {
        channel?: { id?: string };
        container?: { channel_id?: string };
        message?: { channel?: string };
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
      const decidedBy =
        body.user?.name || body.user?.username || body.user?.id || 'unknown';
      if (!pending) {
        const durable = await findDurablePermissionInteractionByRequestId({
          requestId: payload.requestId,
        });
        const callbackChannelId =
          body.channel?.id ||
          body.container?.channel_id ||
          body.message?.channel ||
          '';
        if (!durable || durable.targetJid !== `sl:${callbackChannelId}`) return;
        const allowed = await this.canDecidePermission(
          userId,
          durable.sourceAgentFolder,
          durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
          durable.targetJid,
        );
        if (!allowed) return;
        const resolved = await resolveDurablePermissionInteractionByRequestId({
          requestId: payload.requestId,
          mode,
          approverRef: decidedBy,
          reason: `resolved via Slack after channel restart`,
        });
        if (!resolved) {
          try {
            await this.app?.client.chat.postEphemeral({
              channel: callbackChannelId,
              user: userId,
              text: 'This approval request is no longer active. Retry the request.',
            });
          } catch {
            // ignore
          }
        }
        return;
      }
      if (!permissionDecisionOptions(pending.request).includes(mode)) {
        return;
      }
      const callbackChannelId =
        body.channel?.id ||
        body.container?.channel_id ||
        body.message?.channel ||
        '';
      if (
        pending.decisionPolicy === 'same_channel' &&
        callbackChannelId !== pending.channelId
      ) {
        try {
          await this.app?.client.chat.postEphemeral({
            channel: callbackChannelId || pending.channelId,
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
          pending.sourceAgentFolder,
          pending.decisionPolicy,
          pending.approvalContextJid || `sl:${pending.channelId}`,
        ))
      ) {
        try {
          await this.app?.client.chat.postEphemeral({
            channel: callbackChannelId || pending.channelId,
            user: userId,
            text: 'You are not allowed to decide this permission request.',
          });
        } catch {
          // ignore
        }
        return;
      }
      const decision = decisionForMode(pending.request, mode, decidedBy);
      await this.resolvePermissionPrompt(payload.requestId, {
        ...decision,
      });
    };
    for (const actionId of SLACK_PERMISSION_DECISION_ACTION_IDS) {
      this.app.action(actionId, handlePermissionDecision);
    }
    this.app.action('gantry_userq_select', async (args: any) => {
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
      const callbackChannelId = body.channel?.id || '';
      const userId = body.user?.id || '';
      if (!userId) return;
      const answeredBy =
        body.user?.name || body.user?.username || body.user?.id || 'unknown';
      if (!pending) {
        const durable = await findDurableQuestionInteractionByRequestId({
          requestId: parsed.requestId,
        });
        if (!durable || durable.targetJid !== `sl:${callbackChannelId}`) return;
        const allowed = await this.canDecidePermission(
          userId,
          durable.sourceAgentFolder,
          undefined,
          durable.targetJid,
        );
        if (!allowed) return;
        await resolveDurableQuestionInteractionByRequestId({
          requestId: parsed.requestId,
          questionIndex: parsed.questionIndex,
          optionIndex: parsed.optionIndex,
          finalize: false,
          answeredBy,
        });
        return;
      }
      if (pending.settled) return;
      if (!callbackChannelId || callbackChannelId !== pending.channelId) return;
      if (
        !(await this.canDecidePermission(
          userId,
          pending.sourceAgentFolder,
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
    this.app.action('gantry_userq_done', async (args: any) => {
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
      const callbackChannelId = body.channel?.id || '';
      const userId = body.user?.id || '';
      if (!userId) return;
      const answeredBy =
        body.user?.name || body.user?.username || body.user?.id || 'unknown';
      if (!pending) {
        const durable = await findDurableQuestionInteractionByRequestId({
          requestId: parsed.requestId,
        });
        if (!durable || durable.targetJid !== `sl:${callbackChannelId}`) return;
        const allowed = await this.canDecidePermission(
          userId,
          durable.sourceAgentFolder,
          undefined,
          durable.targetJid,
        );
        if (!allowed) return;
        await resolveDurableQuestionInteractionByRequestId({
          requestId: parsed.requestId,
          questionIndex: parsed.questionIndex,
          finalize: true,
          answeredBy,
        });
        return;
      }
      if (pending.settled || !pending.question.multiSelect) return;
      if (!callbackChannelId || callbackChannelId !== pending.channelId) return;
      if (
        !(await this.canDecidePermission(
          userId,
          pending.sourceAgentFolder,
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
      await this.finalizeUserQuestionPrompt(
        pending,
        selectedLabels,
        answeredBy,
      );
    });
    this.app.action('gantry_userq_other', async (args: any) => {
      await args.ack();
      const action = args.action as { value?: string };
      const body = args.body as {
        channel?: { id?: string };
        user?: { id?: string };
        trigger_id?: string;
      };
      const parsed = this.parseUserQuestionActionValue(action.value);
      if (!parsed) return;
      const triggerId = body.trigger_id;
      if (!triggerId) return;
      const key = this.pendingUserQuestionKey(
        parsed.requestId,
        parsed.questionIndex,
      );
      const pending = this.pendingUserQuestions.get(key);
      const callbackChannelId = body.channel?.id || '';
      const userId = body.user?.id || '';
      if (!userId) return;
      // Free-text "Other" only supports the in-memory pending question (the
      // modal opens and submits within the same worker session); durable
      // cross-restart free text is not modeled.
      if (!pending || pending.settled) return;
      if (!callbackChannelId || callbackChannelId !== pending.channelId) return;
      if (
        !(await this.canDecidePermission(
          userId,
          pending.sourceAgentFolder,
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
      try {
        await this.app?.client.views.open({
          trigger_id: triggerId,
          view: {
            type: 'modal',
            callback_id: 'gantry_userq_other_modal',
            private_metadata: JSON.stringify({
              requestId: parsed.requestId,
              questionIndex: parsed.questionIndex,
              channelId: pending.channelId,
            }),
            title: { type: 'plain_text', text: 'Your answer' },
            submit: { type: 'plain_text', text: 'Submit' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
              {
                type: 'input',
                block_id: 'gantry_userq_other_block',
                label: {
                  type: 'plain_text',
                  text: (pending.question.header || 'Your answer').slice(
                    0,
                    150,
                  ),
                },
                element: {
                  type: 'plain_text_input',
                  action_id: 'gantry_userq_other_input',
                  multiline: true,
                  max_length: 3000,
                  placeholder: {
                    type: 'plain_text',
                    text: 'Type your answer',
                  },
                },
              },
            ],
          },
        });
      } catch (err) {
        logger.debug({ err }, 'Failed to open Slack user-question Other modal');
      }
    });
    this.app.view('gantry_userq_other_modal', async (args: any) => {
      await args.ack();
      const body = args.body as {
        user?: { id?: string; name?: string; username?: string };
      };
      const view = args.view as {
        private_metadata?: string;
        state?: {
          values?: Record<string, Record<string, { value?: string }>>;
        };
      };
      let meta: {
        requestId?: string;
        questionIndex?: number;
        channelId?: string;
      } = {};
      try {
        meta = JSON.parse(view.private_metadata || '{}');
      } catch {
        return;
      }
      if (!meta.requestId || meta.questionIndex === undefined) return;
      const text = (
        view.state?.values?.['gantry_userq_other_block']?.[
          'gantry_userq_other_input'
        ]?.value || ''
      ).trim();
      if (!text) return;
      const key = this.pendingUserQuestionKey(
        meta.requestId,
        meta.questionIndex,
      );
      const pending = this.pendingUserQuestions.get(key);
      if (!pending || pending.settled) return;
      const userId = body.user?.id || '';
      const answeredBy =
        body.user?.name || body.user?.username || body.user?.id || 'unknown';
      if (
        userId &&
        !(await this.canDecidePermission(
          userId,
          pending.sourceAgentFolder,
          undefined,
          `sl:${pending.channelId}`,
        ))
      ) {
        return;
      }
      await this.finalizeUserQuestionPrompt(pending, text, answeredBy);
    });
    registerSlackMessageActionHandler(this.app, this.opts.onMessageAction);
  }
}
