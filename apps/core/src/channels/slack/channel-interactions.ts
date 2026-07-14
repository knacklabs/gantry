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
  buildPermissionPromptFullView,
  decisionForMode,
  formatPermissionReceiptText,
  normalizePermissionAction,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import { SlackChannelState, SlackMessageLike } from './channel-state.js';
import {
  buildPermissionFullViewModalBlocks,
  buildPermissionReceiptBlocks,
} from './permission-blocks.js';
import { registerSlackRichFormHandlers } from './rich-interaction.js';
import { SLACK_PERMISSION_DECISION_ACTION_IDS } from './permission-action-id.js';
import { registerSlackMessageActionHandler } from './channel-message-action-handler.js';
import { registerSlackUtilityHandlers } from './channel-utility-handlers.js';
import {
  ingestSlackMessage as ingestSlackMessageEvent,
  ingestSlackSlashCommand as ingestSlackSlashCommandEvent,
} from './channel-message-ingest.js';
export abstract class SlackChannelInteractions extends SlackChannelState {
  protected async ingestSlackSlashCommand(command: {
    channel_id?: string;
    user_id?: string;
    user_name?: string;
    text?: string;
    trigger_id?: string;
    command_id?: string;
  }): Promise<void> {
    await ingestSlackSlashCommandEvent({
      command,
      opts: this.opts,
      resolveChannelName: (channelId) => this.resolveChannelName(channelId),
      resolveUserName: (userId) => this.resolveUserName(userId),
      isLikelyGroupConversation: (channelId) =>
        this.isLikelyGroupConversation(channelId),
    });
  }
  protected async ingestSlackMessage(
    event: SlackMessageLike,
    options: { forceOwnedTopLevel?: boolean } = {},
  ): Promise<void> {
    await ingestSlackMessageEvent({
      event,
      options,
      opts: this.opts,
      botUserId: this.botUserId,
      resolveChannelName: (channelId) => this.resolveChannelName(channelId),
      resolveUserName: (userId) => this.resolveUserName(userId),
      isLikelyGroupConversation: (channelId) =>
        this.isLikelyGroupConversation(channelId),
      enrichMessage: (jid, slackEvent, targetFolder) =>
        this.enrichMessage(jid, slackEvent, targetFolder),
    });
  }
  protected async canDecidePermission(
    userId: string,
    sourceAgentFolder: string,
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'],
    conversationJid?: string,
    threadId?: string,
    providerAccountId = this.opts.providerAccountId,
  ): Promise<boolean> {
    if (decisionPolicy && decisionPolicy !== 'same_channel') return false;
    if (this.opts.isControlApproverAllowed && conversationJid) {
      return this.opts.isControlApproverAllowed({
        providerId: 'slack',
        providerAccountId,
        agentId: this.opts.agentId,
        conversationJid,
        threadId,
        userId,
        sourceAgentFolder,
        decisionPolicy,
      });
    }
    return false;
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
            providerAccountId?: string;
          }
        | undefined;
      try {
        payload = JSON.parse(action.value) as {
          requestId: string;
          decision: string;
          providerAccountId?: string;
        };
      } catch {
        return;
      }
      if (!payload?.requestId) return;
      const callbackProviderAccountId =
        typeof payload.providerAccountId === 'string'
          ? payload.providerAccountId
          : this.opts.providerAccountId;
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
          durable.threadId ?? undefined,
          callbackProviderAccountId,
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
          pending.request.threadId,
          callbackProviderAccountId,
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
      await this.resolvePermissionPrompt(payload.requestId, decision);
    };
    for (const actionId of SLACK_PERMISSION_DECISION_ACTION_IDS) {
      this.app.action(actionId, handlePermissionDecision);
    }
    this.app.action('gantry_perm_full_view', async (args: any) => {
      await args.ack();
      const body = args.body as {
        channel?: { id?: string };
        container?: { channel_id?: string };
        message?: { channel?: string };
        trigger_id?: string;
        user?: { id?: string };
      };
      const action = args.action as { value?: string };
      const userId = body.user?.id || '';
      const triggerId = body.trigger_id;
      if (!action.value || !userId || !triggerId) return;
      let payload: { requestId?: string; providerAccountId?: string } = {};
      try {
        payload = JSON.parse(action.value) as {
          requestId?: string;
          providerAccountId?: string;
        };
      } catch {
        return;
      }
      if (!payload.requestId) return;
      const callbackProviderAccountId =
        typeof payload.providerAccountId === 'string'
          ? payload.providerAccountId
          : this.opts.providerAccountId;
      const callbackChannelId =
        body.channel?.id ||
        body.container?.channel_id ||
        body.message?.channel ||
        '';
      const pending = this.pendingPermissionPrompts.get(payload.requestId);
      let fullView: ReturnType<typeof buildPermissionPromptFullView>;
      if (pending && !pending.settled) {
        if (
          !(await this.canDecidePermission(
            userId,
            pending.sourceAgentFolder,
            pending.decisionPolicy,
            pending.approvalContextJid || `sl:${pending.channelId}`,
            undefined,
            callbackProviderAccountId,
          ))
        ) {
          try {
            await this.app?.client.chat.postEphemeral({
              channel: callbackChannelId || pending.channelId,
              user: userId,
              text: 'You are not allowed to view this permission payload.',
            });
          } catch {
            // ignore
          }
          return;
        }
        fullView = buildPermissionPromptFullView(pending.request);
      } else {
        const durable = await findDurablePermissionInteractionByRequestId({
          requestId: payload.requestId,
        });
        if (!durable || durable.targetJid !== `sl:${callbackChannelId}`) return;
        if (
          !(await this.canDecidePermission(
            userId,
            durable.sourceAgentFolder,
            durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
            durable.targetJid,
            durable.threadId ?? undefined,
            callbackProviderAccountId,
          ))
        ) {
          try {
            await this.app?.client.chat.postEphemeral({
              channel: callbackChannelId,
              user: userId,
              text: 'You are not allowed to view this permission payload.',
            });
          } catch {
            // ignore
          }
          return;
        }
        fullView = durable.fullView;
      }
      if (!fullView) return;
      try {
        await this.app?.client.views.open({
          trigger_id: triggerId,
          view: {
            type: 'modal',
            callback_id: 'gantry_perm_full_view_modal',
            title: {
              type: 'plain_text',
              text: fullView.title.slice(0, 24),
            },
            close: { type: 'plain_text', text: 'Close' },
            blocks: buildPermissionFullViewModalBlocks(fullView) as any,
          },
        });
      } catch (err) {
        logger.debug({ err }, 'Failed to open Slack permission full view');
      }
    });
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
    registerSlackRichFormHandlers({
      app: this.app,
      pendingRichForms: this.pendingRichForms,
    });
    registerSlackMessageActionHandler(this.app, this.opts);
  }
}
