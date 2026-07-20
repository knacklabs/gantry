import { logger } from '../../infrastructure/logging/logger.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../shared/permission-timeout.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionCallbackScope,
} from '../../domain/types.js';
import {
  claimPermissionInteractionCallback,
  findDurablePermissionInteractionByRequestId,
  recoverDurablePermissionDecision,
  releasePermissionInteractionCallback,
  samePermissionCallbackLocator,
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
import { registerSlackUserQuestionHandlers } from './user-question-interactions.js';
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
    providerAlias: string,
    decision: PermissionApprovalDecision,
    respond?: (payload: Record<string, unknown>) => Promise<unknown>,
    settleInternally = false,
  ): Promise<boolean> {
    const pending = this.pendingPermissionPrompts.get(providerAlias);
    if (!pending || pending.settled) return false;
    const text = formatPermissionReceiptText(
      pending.request.requestId,
      pending.request,
      decision,
    );
    if (
      !settleInternally &&
      !(await this.terminalizePermissionPrompt(
        pending.request.requestId,
        decision,
        text,
        respond,
      ))
    ) {
      return false;
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pendingPermissionPrompts.delete(providerAlias);
    pending.resolve(decision);
    return true;
  }
  protected async timeoutPermissionPrompt(
    providerAlias: string,
  ): Promise<void> {
    let result = await this.claimAndResolvePermissionPrompt(
      providerAlias,
      'cancel',
      'system',
      undefined,
      'timed out',
      true,
    );
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
        if (!this.pendingPermissionPrompts.has(providerAlias)) return;
        result = await this.claimAndResolvePermissionPrompt(
          providerAlias,
          'cancel',
          'system',
          undefined,
          'timed out',
          true,
        );
        if (result !== 'retryable') break;
      }
    }
    if (result === 'already_decided') return;
    if (!this.pendingPermissionPrompts.has(providerAlias)) return;
    await this.resolvePermissionPrompt(
      providerAlias,
      {
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'timed out',
      },
      undefined,
      true,
    );
  }
  protected async claimAndResolvePermissionPrompt(
    providerAlias: string,
    mode: NonNullable<PermissionApprovalDecision['mode']>,
    approverRef: string,
    respond?: (payload: Record<string, unknown>) => Promise<unknown>,
    reason?: string,
    settleInternally = false,
  ): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'> {
    const pending = this.pendingPermissionPrompts.get(providerAlias);
    if (!pending || pending.settled) return 'already_decided';
    const claimed = await claimPermissionInteractionCallback({
      scope: pending.callback.scope,
      mode,
      approverRef,
      matchKind: pending.callback.matchKind,
      providerAlias,
    });
    if (claimed.status === 'already_decided')
      return claimed.ownerless ? 'ownerless' : 'already_decided';
    if (claimed.status === 'retryable') return 'retryable';
    const decision = {
      ...decisionForMode(pending.request, mode, approverRef),
      ...(reason ? { reason } : {}),
      permissionCallbackClaim: claimed.claim,
    };
    if (
      await this.resolvePermissionPrompt(
        providerAlias,
        decision,
        respond,
        settleInternally,
      )
    ) {
      return 'settled';
    }
    await releasePermissionInteractionCallback({ claim: claimed.claim });
    return 'retryable';
  }
  private async terminalizePermissionPrompt(
    requestId: string,
    decision: PermissionApprovalDecision,
    text: string,
    respond?: (payload: Record<string, unknown>) => Promise<unknown>,
  ): Promise<boolean> {
    if (!respond) return false;
    if (decision.approved && decision.mode !== 'cancel') {
      try {
        await respond({ delete_original: true });
        return true;
      } catch (err) {
        logger.debug(
          { requestId, err },
          'Failed to delete approved Slack permission prompt via response URL; replacing with fallback receipt',
        );
      }
    }
    try {
      await respond({
        replace_original: true,
        text,
        blocks: buildPermissionReceiptBlocks(text) as any,
      });
      return true;
    } catch (err) {
      logger.debug(
        { requestId, err },
        'Failed to replace Slack permission prompt via response URL',
      );
      return false;
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
        response_url?: string;
        user?: { id?: string; name?: string; username?: string };
      };
      const action = args.action as { value?: string };
      const userId = body.user?.id || '';
      if (!action.value || !userId) return;
      let payload:
        | {
            callback?: unknown;
            decision: string;
            providerAccountId?: string;
          }
        | undefined;
      try {
        payload = JSON.parse(action.value) as {
          callback?: unknown;
          decision: string;
          providerAccountId?: string;
        };
      } catch {
        return;
      }
      const callback = readSlackPermissionCallback(payload?.callback);
      if (!payload || !callback) return;
      const callbackProviderAccountId =
        typeof payload.providerAccountId === 'string'
          ? payload.providerAccountId
          : this.opts.providerAccountId;
      const mode = normalizePermissionAction(payload.decision);
      if (!mode) return;
      const pending = this.pendingPermissionPrompts.get(callback.providerAlias);
      const respond =
        body.response_url && typeof args.respond === 'function'
          ? args.respond
          : undefined;
      if (!pending) {
        const callbackChannelId =
          body.channel?.id ||
          body.container?.channel_id ||
          body.message?.channel ||
          '';
        await recoverDurablePermissionDecision({
          locator: {
            kind: 'scope',
            scope: callback.scope,
            matchKind: callback.matchKind,
            providerAlias: callback.providerAlias,
          },
          surfaceJid: `sl:${callbackChannelId}`,
          incomingMode: mode,
          incomingApprover: userId,
          authorize: (durable) =>
            this.canDecidePermission(
              userId,
              durable.sourceAgentFolder,
              durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
              durable.approvalContextJid ?? '',
              durable.threadId ?? undefined,
              callbackProviderAccountId,
            ),
          terminalize: (receipt) => {
            const request =
              receipt.status === 'resolved'
                ? (receipt.request as PermissionApprovalRequest | null)
                : null;
            const text =
              receipt.status === 'expired'
                ? receipt.text
                : request
                  ? formatPermissionReceiptText(
                      request.requestId,
                      request,
                      receipt.decision,
                    )
                  : receipt.text!;
            return this.terminalizePermissionPrompt(
              receipt.status === 'resolved'
                ? receipt.context.requestId
                : callback.scope.interactionId,
              receipt.decision,
              text,
              respond,
            );
          },
          feedback: async (text) => {
            await this.app?.client.chat.postEphemeral({
              channel: callbackChannelId,
              user: userId,
              text,
            });
          },
        });
        return;
      }
      if (!samePermissionCallbackLocator(pending.callback, callback)) return;
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
      const result = await this.claimAndResolvePermissionPrompt(
        callback.providerAlias,
        mode,
        userId,
        respond,
      );
      if (result === 'already_decided' || result === 'ownerless') {
        await respond?.({
          replace_original: true,
          text: 'This permission request was already decided.',
        });
      }
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
      let payload: { callback?: unknown; providerAccountId?: string } = {};
      try {
        payload = JSON.parse(action.value) as {
          callback?: unknown;
          providerAccountId?: string;
        };
      } catch {
        return;
      }
      const callback = readSlackPermissionCallback(payload.callback);
      if (!callback) return;
      const callbackProviderAccountId =
        typeof payload.providerAccountId === 'string'
          ? payload.providerAccountId
          : this.opts.providerAccountId;
      const callbackChannelId =
        body.channel?.id ||
        body.container?.channel_id ||
        body.message?.channel ||
        '';
      const pending = this.pendingPermissionPrompts.get(callback.providerAlias);
      let fullView: ReturnType<typeof buildPermissionPromptFullView>;
      if (pending && !pending.settled) {
        if (!samePermissionCallbackLocator(pending.callback, callback)) return;
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
          scope: callback.scope,
          providerAlias: callback.providerAlias,
        });
        if (!durable || durable.targetJid !== `sl:${callbackChannelId}`) return;
        if (
          !(await this.canDecidePermission(
            userId,
            durable.sourceAgentFolder,
            durable.decisionPolicy as PermissionApprovalRequest['decisionPolicy'],
            durable.approvalContextJid ?? '',
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
    registerSlackUserQuestionHandlers({
      app: this.app,
      pendingUserQuestions: this.pendingUserQuestions,
      parseActionValue: (value) => this.parseUserQuestionActionValue(value),
      pendingKey: (callback) => this.pendingUserQuestionKey(callback),
      canAnswer: (userId, sourceAgentFolder, conversationJid) =>
        this.canDecidePermission(
          userId,
          sourceAgentFolder,
          undefined,
          conversationJid,
        ),
      refreshPrompt: (pending) => this.refreshUserQuestionPrompt(pending),
      finalizePrompt: (pending, selection, answeredBy) =>
        this.finalizeUserQuestionPrompt(pending, selection, answeredBy),
    });
    registerSlackRichFormHandlers({
      app: this.app,
      pendingRichForms: this.pendingRichForms,
    });
    registerSlackMessageActionHandler(this.app, this.opts);
  }
}

type SlackPermissionCallback = {
  providerAlias: string;
  scope: PermissionCallbackScope;
  matchKind: 'individual' | 'batch';
};

function readSlackPermissionCallback(
  value: unknown,
): SlackPermissionCallback | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const scope = candidate.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return null;
  const parsedScope = scope as Record<string, unknown>;
  if (
    typeof candidate.providerAlias !== 'string' ||
    !candidate.providerAlias ||
    (candidate.matchKind !== 'individual' && candidate.matchKind !== 'batch') ||
    typeof parsedScope.appId !== 'string' ||
    !parsedScope.appId ||
    typeof parsedScope.sourceAgentFolder !== 'string' ||
    !parsedScope.sourceAgentFolder ||
    typeof parsedScope.interactionId !== 'string' ||
    !parsedScope.interactionId
  ) {
    return null;
  }
  return {
    providerAlias: candidate.providerAlias,
    scope: {
      appId: parsedScope.appId,
      sourceAgentFolder: parsedScope.sourceAgentFolder,
      interactionId: parsedScope.interactionId,
    },
    matchKind: candidate.matchKind,
  };
}
