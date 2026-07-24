import path from 'path';

import { App } from '@slack/bolt';

import { logger } from '../../infrastructure/logging/logger.js';
import { createInboundAttachmentStorageRef } from '../../shared/inbound-attachment-writer.js';
import { ensurePrivateDirSync } from '../../shared/private-fs.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import {
  NewMessage,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionCallbackScope,
  RichInteractionRequest,
  UserQuestionRequest,
} from '../../domain/types.js';
import { resolveWorkspaceFolderPath } from '../../platform/workspace-folder.js';
import { ChannelOpts } from '../channel-provider.js';
import { StreamResetEpochs } from '../stream-reset-epochs.js';
import { hydrateSlackConversationContext } from './conversation-context.js';
import {
  encodeSlackActionValue,
  formatSlackUserQuestionBody,
  formatSlackUserQuestionPromptText,
  parseSlackUserQuestionActionValue,
  truncateSlackButtonText,
  truncateSlackText,
} from './channel-user-question-utils.js';
import {
  tryNativeStreamAppend,
  tryNativeStreamStart,
  tryNativeStreamStop,
} from './native-stream.js';
import { writeSlackAttachmentResponse } from './attachment-download.js';
import type { DurableQuestionCallback } from '../../application/interactions/pending-interaction-durability.js';

interface SlackAttachmentDownload {
  filePath: string;
  storageRef: string;
}

type SlackMessageAttachments = NonNullable<NewMessage['attachments']>;
type UQSelection = { selected: string | string[]; answeredBy?: string };
type PendingPermissionPromptMap = Map<string, PendingPermissionPrompt>;

export interface ActiveStreamState {
  channelId: string;
  threadId?: string;
  rawBuffer: string;
  lastSentText: string;
  lastNativeText: string;
  messageTs?: string;
  fallbackMessageTs: string[];
  nativeStreamTs?: string;
  nativeEnabled: boolean;
  lastFlushAt: number;
}

export interface ActiveProgressState {
  channelId: string;
  threadId?: string;
  messageTs?: string;
  lastText: string;
  generation?: number;
}

export interface PendingPermissionPrompt {
  callback: {
    providerAlias: string;
    scope: PermissionCallbackScope;
    matchKind: 'individual' | 'batch';
  };
  channelId: string;
  sourceAgentFolder: string;
  decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  approvalContextJid?: string;
  request: PermissionApprovalRequest;
  messageTs: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: PermissionApprovalDecision) => void;
  settled: boolean;
}

export interface PendingUserQuestionState {
  callback: DurableQuestionCallback;
  requestId: string;
  questionIndex: number;
  question: UserQuestionRequest['questions'][number];
  promptText: string;
  selectedOptionIndexes: Set<number>;
  channelId: string;
  sourceAgentFolder: string;
  messageTs: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (selection: UQSelection) => void;
  settled: boolean;
}

export interface SlackMessageLike {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  files?: Array<{
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    url_private?: string;
    url_private_download?: string;
  }>;
  client_msg_id?: string;
  edited?: unknown;
}

export abstract class SlackChannelState {
  name = 'slack';

  protected app: App | null = null;
  protected readonly botToken: string;
  protected readonly appToken: string;
  protected readonly opts: Pick<
    ChannelOpts,
    | 'onMessage'
    | 'onChatMetadata'
    | 'conversationRoutes'
    | 'runtimeSettings'
    | 'isControlApproverAllowed'
    | 'onMessageAction'
    | 'providerAccountId'
    | 'agentId'
  >;
  protected botUserId: string | null = null;
  protected userNameCache = new Map<string, string>();
  protected channelNameCache = new Map<string, string>();
  protected activeStreams = new Map<string, ActiveStreamState>();
  protected readonly streamResetEpochs = new StreamResetEpochs();
  protected streamGenerationByJid = new Map<string, number>();
  protected sealedStreamGenerationByJid = new Map<string, number>();
  protected activeProgress = new Map<string, ActiveProgressState>();
  protected sealedProgressGenerationByKey = new Map<string, number>();
  protected progressStateLoaded = false;
  protected pendingPermissionPrompts: PendingPermissionPromptMap = new Map();
  protected pendingUserQuestions = new Map<string, PendingUserQuestionState>();
  protected pendingTodos = new Map<string, { channel: string; ts: string }>();
  protected pendingRichForms = new Map<string, RichInteractionRequest>();

  dropPendingInteraction(
    kind: 'permission' | 'question',
    request: PermissionApprovalRequest | UserQuestionRequest,
  ): void {
    if (kind === 'permission') {
      for (const [providerAlias, pending] of this.pendingPermissionPrompts) {
        if (
          pending.request.requestId !== request.requestId ||
          pending.sourceAgentFolder !== request.sourceAgentFolder ||
          (pending.request.appId || 'default') !== (request.appId || 'default')
        ) {
          continue;
        }
        pending.settled = true;
        clearTimeout(pending.timer);
        this.pendingPermissionPrompts.delete(providerAlias);
      }
      return;
    }
    for (const [key, pending] of this.pendingUserQuestions) {
      if (
        pending.requestId !== request.requestId ||
        pending.sourceAgentFolder !== request.sourceAgentFolder ||
        pending.callback.scope.appId !== (request.appId || 'default')
      ) {
        continue;
      }
      pending.settled = true;
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingUserQuestions.delete(key);
    }
  }

  constructor(botToken: string, appToken: string, opts: ChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
  }

  protected streamKey(jid: string, threadId?: string): string {
    return `${jid}:${threadId || ''}`;
  }

  protected progressKey(jid: string, threadId?: string): string {
    return `progress:${this.streamKey(jid, threadId)}`;
  }

  protected shouldAcceptProgressUpdate(
    key: string,
    generation?: number,
    done?: boolean,
  ): boolean {
    if (done || generation === undefined) return true;
    const sealed = this.sealedProgressGenerationByKey.get(key);
    return sealed === undefined || generation > sealed;
  }

  protected markProgressGenerationDone(key: string, generation?: number): void {
    if (generation === undefined) return;
    const sealed = this.sealedProgressGenerationByKey.get(key);
    if (sealed === undefined || generation > sealed) {
      this.sealedProgressGenerationByKey.set(key, generation);
    }
  }

  protected pendingUserQuestionKey(callback: DurableQuestionCallback): string {
    return callback.providerAlias;
  }

  protected formatUserQuestionPromptText(
    request: UserQuestionRequest,
    question: UserQuestionRequest['questions'][number],
    timeoutMs: number,
  ): string {
    return formatSlackUserQuestionPromptText(request, question, timeoutMs);
  }

  protected buildUserQuestionBlocks(
    pending: PendingUserQuestionState,
  ): Array<Record<string, unknown>> {
    const elements: Array<Record<string, unknown>> =
      pending.question.options.map((option, optionIndex) => {
        const isSelected = pending.selectedOptionIndexes.has(optionIndex);
        const prefix = pending.question.multiSelect
          ? isSelected
            ? '[x] '
            : '[ ] '
          : '';
        const label = truncateSlackButtonText(
          `${prefix}${optionIndex + 1}. ${option.label}`,
        );
        return {
          type: 'button',
          action_id: `gantry_userq_select_${optionIndex}`,
          text: {
            type: 'plain_text',
            text: label,
          },
          value: encodeSlackActionValue({
            callback: pending.callback,
            optionIndex,
          }),
        };
      });

    if (pending.question.multiSelect) {
      elements.push({
        type: 'button',
        action_id: 'gantry_userq_done',
        text: {
          type: 'plain_text',
          text: truncateSlackButtonText(
            pending.selectedOptionIndexes.size > 0
              ? `Done (${pending.selectedOptionIndexes.size})`
              : 'Done',
          ),
        },
        style: 'primary',
        value: encodeSlackActionValue({
          callback: pending.callback,
          done: true,
        }),
      });
    }

    elements.push({
      type: 'button',
      action_id: 'gantry_userq_other',
      text: {
        type: 'plain_text',
        text: truncateSlackButtonText('✏️ Other…'),
      },
      value: encodeSlackActionValue({
        callback: pending.callback,
      }),
    });

    return [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: truncateSlackText(`❓ ${pending.question.header}`, 150),
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: formatSlackUserQuestionBody(pending.question),
        },
      },
      {
        type: 'actions',
        elements,
      },
    ];
  }

  protected parseUserQuestionActionValue(
    rawValue: string | undefined,
  ): { callback: DurableQuestionCallback; optionIndex?: number } | null {
    return parseSlackUserQuestionActionValue(rawValue);
  }

  protected async refreshUserQuestionPrompt(
    pending: PendingUserQuestionState,
  ): Promise<void> {
    if (!this.app) return;
    try {
      await this.app.client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text: pending.promptText,
        blocks: this.buildUserQuestionBlocks(pending) as any,
      });
    } catch (err) {
      logger.debug(
        {
          requestId: pending.requestId,
          questionIndex: pending.questionIndex,
          err,
        },
        'Failed to refresh Slack user question prompt',
      );
    }
  }

  protected async finalizeUserQuestionPrompt(
    pending: PendingUserQuestionState,
    selection: string | string[],
    answeredBy?: string,
    reason?: string,
  ): Promise<void> {
    if (pending.settled) return;
    pending.settled = true;
    const key = this.pendingUserQuestionKey(pending.callback);
    this.pendingUserQuestions.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve({ selected: selection, answeredBy });

    if (!this.app) return;
    const selectionText = Array.isArray(selection)
      ? selection.join(', ')
      : selection;
    const actor = answeredBy ? ` (by ${answeredBy})` : '';
    const text = selectionText
      ? `✅ ${pending.question.header} · ${selectionText}${actor}`
      : `⌛ ${pending.question.header} · ${reason || 'no answer'}`;
    try {
      await this.app.client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text,
        blocks: [
          { type: 'context', elements: [{ type: 'mrkdwn', text }] },
        ] as any,
      });
    } catch (err) {
      logger.debug(
        {
          requestId: pending.requestId,
          questionIndex: pending.questionIndex,
          err,
        },
        'Failed to finalize Slack user question prompt',
      );
    }
  }
  protected clearStreamingStateForJid(jid: string): void {
    for (const [key, state] of this.activeStreams.entries()) {
      if (!key.startsWith(`${jid}:`)) continue;
      if (state.nativeStreamTs) {
        void this.tryNativeStreamStop(state.channelId, state.nativeStreamTs);
      }
      this.streamResetEpochs.deleteState(key, this.activeStreams);
    }
  }

  protected shouldAcceptStreamingChunk(
    jid: string,
    generation?: number,
  ): boolean {
    if (generation === undefined) return true;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed !== undefined && generation <= sealed) {
      return false;
    }

    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) {
      this.streamGenerationByJid.set(jid, generation);
      return true;
    }
    if (generation < latest) {
      return false;
    }
    if (generation > latest) {
      this.clearStreamingStateForJid(jid);
      this.streamGenerationByJid.set(jid, generation);
    }
    return true;
  }

  protected markStreamingGenerationDone(
    jid: string,
    generation?: number,
  ): void {
    if (generation === undefined) return;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed === undefined || generation > sealed) {
      this.sealedStreamGenerationByJid.set(jid, generation);
    }
  }

  protected sealStreamingGenerationOnReset(jid: string): void {
    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) return;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed === undefined || latest > sealed) {
      this.sealedStreamGenerationByJid.set(jid, latest);
    }
  }

  protected isCurrentStreamingGeneration(
    jid: string,
    generation?: number,
  ): boolean {
    if (generation === undefined) return true;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed !== undefined && generation <= sealed) {
      return false;
    }
    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) return true;
    return generation === latest;
  }

  protected parseJid(jid: string): { channelId: string } | null {
    if (!jid.startsWith('sl:')) return null;
    const channelId = jid.slice(3).trim();
    if (!channelId) return null;
    return { channelId };
  }

  protected isLikelyGroupConversation(channelId: string): boolean {
    return !(channelId.startsWith('D') || channelId.startsWith('U'));
  }

  protected async resolveUserName(userId: string | undefined): Promise<string> {
    if (!userId) return 'Unknown User';
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;
    if (!this.app) return userId;

    try {
      const result = (await this.app.client.users.info({
        user: userId,
      })) as {
        ok?: boolean;
        user?: {
          real_name?: string;
          name?: string;
          profile?: { display_name?: string; real_name?: string };
        };
      };
      const displayName =
        result.user?.profile?.display_name ||
        result.user?.real_name ||
        result.user?.profile?.real_name ||
        result.user?.name ||
        userId;
      this.userNameCache.set(userId, displayName);
      return displayName;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return userId;
    }
  }

  protected async resolveChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;
    if (!this.app) return channelId;

    try {
      const info = (await this.app.client.conversations.info({
        channel: channelId,
      })) as {
        ok?: boolean;
        channel?: {
          id?: string;
          name?: string;
          is_im?: boolean;
          user?: string;
        };
      };

      if (info.channel?.is_im && info.channel.user) {
        const userName = await this.resolveUserName(info.channel.user);
        const name = `DM with ${userName}`;
        this.channelNameCache.set(channelId, name);
        return name;
      }

      const name = info.channel?.name || channelId;
      this.channelNameCache.set(channelId, name);
      return name;
    } catch (err) {
      logger.debug({ channelId, err }, 'Failed to resolve Slack channel name');
      return channelId;
    }
  }

  protected sanitizeFilename(raw: string): string {
    const trimmed = raw.trim();
    const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
    return safe || 'attachment.bin';
  }

  protected async downloadSlackAttachment(
    jid: string,
    file: {
      name?: string;
      title?: string;
      url_private?: string;
      url_private_download?: string;
    },
    threadId?: string,
    targetFolder?: string,
  ): Promise<SlackAttachmentDownload | null> {
    const url = file.url_private_download || file.url_private;
    if (!url) return null;
    const groups = targetFolder
      ? []
      : findConversationRoutesForChat(
          this.opts.conversationRoutes(),
          jid,
          threadId,
          this.opts.providerAccountId,
        );
    if (!targetFolder && groups.length < 1) return null;
    const filename = this.sanitizeFilename(
      file.name || file.title || 'attachment.bin',
    );
    const storageRef = createInboundAttachmentStorageRef(filename);
    const folders = targetFolder
      ? [targetFolder]
      : Array.from(new Set(groups.map(([, group]) => group.folder)));
    if (folders.length !== 1) return null;

    try {
      const groupDir = resolveWorkspaceFolderPath(folders[0]);
      const attachDir = path.join(groupDir, 'attachments');
      ensurePrivateDirSync(attachDir);
      const destPath = path.join(groupDir, ...storageRef.split('/'));
      const resp = await fetch(url, {
        headers: {
          authorization: `Bearer ${this.botToken}`,
        },
      });
      if (!resp.ok) {
        logger.warn(
          { jid, status: resp.status, filename },
          'Failed to download Slack attachment',
        );
        return null;
      }

      const wrote = await writeSlackAttachmentResponse(
        resp,
        groupDir,
        storageRef,
      );
      if (!wrote) return null;
      return { filePath: destPath, storageRef };
    } catch (err) {
      if (isFileExistsError(err)) throw err;
      logger.warn({ jid, err, filename }, 'Slack attachment download failed');
      return null;
    }
  }

  protected async enrichMessage(
    jid: string,
    event: SlackMessageLike,
    targetFolder?: string,
  ): Promise<{ text: string; attachments: SlackMessageAttachments }> {
    const lines: string[] = [];
    const attachments: SlackMessageAttachments = [];
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (text) lines.push(text);

    if (Array.isArray(event.files)) {
      for (const file of event.files) {
        const download = await this.downloadSlackAttachment(
          jid,
          file,
          event.thread_ts,
          targetFolder,
        );
        const label = file.name || file.title || 'attachment';
        lines.push(`Attachment: ${label}`);
        const attachment: SlackMessageAttachments[number] = {
          id: file.id ? `slack-file:${file.id}` : undefined,
          kind: file.mimetype?.startsWith('image/') ? 'image' : 'file',
          contentType: file.mimetype,
          externalId: file.id,
        };
        if (download) attachment.storageRef = download.storageRef;
        attachments.push(attachment);
      }
    }

    return { text: lines.join('\n').trim(), attachments };
  }

  async hydrateConversationContext(
    request: Parameters<typeof hydrateSlackConversationContext>[0],
  ) {
    return hydrateSlackConversationContext(request, {
      app: this.app,
      botUserId: this.botUserId,
      parseJid: (jid) => this.parseJid(jid),
      resolveUserName: (userId) => this.resolveUserName(userId),
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
}

function isFileExistsError(error: unknown): boolean {
  let current = error;
  while (typeof current === 'object' && current !== null) {
    if ('code' in current && current.code === 'EEXIST') return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}
