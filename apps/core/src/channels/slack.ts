import fs from 'fs';
import path from 'path';

import { App } from '@slack/bolt';

import {
  PERMISSION_APPROVAL_TIMEOUT_MS,
  SLACK_PERMISSION_APPROVER_IDS,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import {
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../core/types.js';
import {
  formatOutboundForChannel,
  stripInternalTagsPreserveWhitespace,
} from '../messaging/router.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { readEnvFile } from '../core/env.js';
import { ChannelAdapter, ChannelOpts } from './channel-provider.js';

const SLACK_STREAM_UPDATE_INTERVAL_MS = 900;
const SLACK_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const SLACK_BUTTON_TEXT_MAX_LENGTH = 75;
const SLACK_ACTION_VALUE_MAX_LENGTH = 2000;

interface ActiveStreamState {
  channelId: string;
  threadId?: string;
  rawBuffer: string;
  lastSentText: string;
  lastNativeText: string;
  messageTs?: string;
  nativeStreamTs?: string;
  nativeEnabled: boolean;
  lastFlushAt: number;
}

interface ActiveProgressState {
  channelId: string;
  threadId?: string;
  messageTs?: string;
  lastText: string;
}

interface PendingPermissionPrompt {
  channelId: string;
  messageTs: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: PermissionApprovalDecision) => void;
  settled: boolean;
}

interface PendingUserQuestionState {
  requestId: string;
  questionIndex: number;
  question: UserQuestionRequest['questions'][number];
  promptText: string;
  selectedOptionIndexes: Set<number>;
  channelId: string;
  messageTs: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (selection: {
    selected: string | string[];
    answeredBy?: string;
  }) => void;
  settled: boolean;
}

interface SlackMessageLike {
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

export class SlackChannel implements ChannelAdapter {
  name = 'slack';

  private app: App | null = null;
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly opts: Pick<
    ChannelOpts,
    'onMessage' | 'onChatMetadata' | 'registeredGroups'
  >;
  private botUserId: string | null = null;
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();
  private activeStreams = new Map<string, ActiveStreamState>();
  private streamGenerationByJid = new Map<string, number>();
  private sealedStreamGenerationByJid = new Map<string, number>();
  private activeProgress = new Map<string, ActiveProgressState>();
  private pendingPermissionPrompts = new Map<string, PendingPermissionPrompt>();
  private pendingUserQuestions = new Map<string, PendingUserQuestionState>();

  constructor(botToken: string, appToken: string, opts: ChannelOpts) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
  }

  private streamKey(jid: string, threadId?: string): string {
    return `${jid}:${threadId || ''}`;
  }

  private progressKey(jid: string, threadId?: string): string {
    return `progress:${this.streamKey(jid, threadId)}`;
  }

  private pendingUserQuestionKey(
    requestId: string,
    questionIndex: number,
  ): string {
    return `${requestId}:${questionIndex}`;
  }

  private truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}...`;
  }

  private truncateButtonText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return 'Option';
    return this.truncateText(trimmed, SLACK_BUTTON_TEXT_MAX_LENGTH);
  }

  private encodeActionValue(value: Record<string, unknown>): string {
    const serialized = JSON.stringify(value);
    if (serialized.length <= SLACK_ACTION_VALUE_MAX_LENGTH) {
      return serialized;
    }
    return JSON.stringify({
      requestId: value.requestId,
      questionIndex: value.questionIndex,
    });
  }

  private formatPermissionToolInputLines(
    request: PermissionApprovalRequest,
  ): string[] {
    if (!request.toolInput || typeof request.toolInput !== 'object') return [];
    const input = request.toolInput;
    if (
      request.toolName === 'Bash' &&
      typeof input.command === 'string' &&
      input.command.trim()
    ) {
      return [`Command: \`${this.truncateText(input.command.trim(), 300)}\``];
    }
    if (request.toolName === 'Edit' || request.toolName === 'Write') {
      const lines: string[] = [];
      if (typeof input.file_path === 'string' && input.file_path.trim()) {
        lines.push(`File: ${this.truncateText(input.file_path.trim(), 250)}`);
      }
      if (typeof input.old_string === 'string' && input.old_string.trim()) {
        lines.push(
          `Replacing: ${this.truncateText(input.old_string.trim(), 150)}`,
        );
      }
      if (typeof input.new_string === 'string' && input.new_string.trim()) {
        lines.push(`With: ${this.truncateText(input.new_string.trim(), 150)}`);
      }
      if (lines.length > 0) return lines;
    }
    try {
      return [`Input: ${this.truncateText(JSON.stringify(input), 300)}`];
    } catch {
      return ['Input: [unserializable]'];
    }
  }

  private formatUserQuestionPromptText(
    question: UserQuestionRequest['questions'][number],
    timeoutMs: number,
  ): string {
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
    const lines = [`*${question.header}*`, question.question, ''];
    question.options.forEach((option, optionIndex) => {
      const description = option.description
        ? ` — ${this.truncateText(option.description, 180)}`
        : '';
      lines.push(`${optionIndex + 1}. ${option.label}${description}`);
      if (option.preview) {
        lines.push(`Preview: ${this.truncateText(option.preview, 180)}`);
      }
    });
    lines.push('');
    if (question.multiSelect) {
      lines.push('Select one or more options, then click Done.');
    } else {
      lines.push('Select one option.');
    }
    lines.push(`Reply timeout: ${timeoutMinutes} minute(s)`);
    return lines.join('\n');
  }

  private buildUserQuestionBlocks(
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
        const label = this.truncateButtonText(
          `${prefix}${optionIndex + 1}. ${option.label}`,
        );
        return {
          type: 'button',
          action_id: 'myclaw_userq_select',
          text: {
            type: 'plain_text',
            text: label,
          },
          value: this.encodeActionValue({
            requestId: pending.requestId,
            questionIndex: pending.questionIndex,
            optionIndex,
          }),
        };
      });

    if (pending.question.multiSelect) {
      elements.push({
        type: 'button',
        action_id: 'myclaw_userq_done',
        text: {
          type: 'plain_text',
          text: this.truncateButtonText(
            pending.selectedOptionIndexes.size > 0
              ? `Done (${pending.selectedOptionIndexes.size})`
              : 'Done',
          ),
        },
        style: 'primary',
        value: this.encodeActionValue({
          requestId: pending.requestId,
          questionIndex: pending.questionIndex,
          done: true,
        }),
      });
    }

    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: pending.promptText,
        },
      },
      {
        type: 'actions',
        elements,
      },
    ];
  }

  private parseUserQuestionActionValue(
    rawValue: string | undefined,
  ): { requestId: string; questionIndex: number; optionIndex?: number } | null {
    if (!rawValue) return null;
    try {
      const parsed = JSON.parse(rawValue) as {
        requestId?: unknown;
        questionIndex?: unknown;
        optionIndex?: unknown;
      };
      if (
        typeof parsed.requestId !== 'string' ||
        !Number.isInteger(parsed.questionIndex)
      ) {
        return null;
      }
      if (
        parsed.optionIndex !== undefined &&
        !Number.isInteger(parsed.optionIndex)
      ) {
        return null;
      }
      return {
        requestId: parsed.requestId,
        questionIndex: parsed.questionIndex as number,
        ...(typeof parsed.optionIndex === 'number'
          ? { optionIndex: parsed.optionIndex as number }
          : {}),
      };
    } catch {
      return null;
    }
  }

  private async refreshUserQuestionPrompt(
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

  private async finalizeUserQuestionPrompt(
    pending: PendingUserQuestionState,
    selection: string | string[],
    answeredBy?: string,
    reason?: string,
  ): Promise<void> {
    if (pending.settled) return;
    pending.settled = true;
    const key = this.pendingUserQuestionKey(
      pending.requestId,
      pending.questionIndex,
    );
    this.pendingUserQuestions.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve({ selected: selection, answeredBy });

    if (!this.app) return;
    const selectionText = Array.isArray(selection)
      ? selection.join(', ')
      : selection;
    const status = reason || 'answered';
    const actor = answeredBy ? ` by ${answeredBy}` : '';
    const text = `Question: ${pending.question.header}\nAnswer: ${selectionText || '[none]'}\nStatus: ${status}${actor}`;
    try {
      await this.app.client.chat.update({
        channel: pending.channelId,
        ts: pending.messageTs,
        text,
        blocks: [],
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

  private clearStreamingStateForJid(jid: string): void {
    for (const [key, state] of this.activeStreams.entries()) {
      if (!key.startsWith(`${jid}:`)) continue;
      if (state.nativeStreamTs) {
        void this.tryNativeStreamStop(state.channelId, state.nativeStreamTs);
      }
      this.activeStreams.delete(key);
    }
  }

  private shouldAcceptStreamingChunk(
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

  private markStreamingGenerationDone(jid: string, generation?: number): void {
    if (generation === undefined) return;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed === undefined || generation > sealed) {
      this.sealedStreamGenerationByJid.set(jid, generation);
    }
  }

  private sealStreamingGenerationOnReset(jid: string): void {
    const latest = this.streamGenerationByJid.get(jid);
    if (latest === undefined) return;
    const sealed = this.sealedStreamGenerationByJid.get(jid);
    if (sealed === undefined || latest > sealed) {
      this.sealedStreamGenerationByJid.set(jid, latest);
    }
  }

  private isCurrentStreamingGeneration(
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

  private parseJid(jid: string): { channelId: string } | null {
    if (!jid.startsWith('sl:')) return null;
    const channelId = jid.slice(3).trim();
    if (!channelId) return null;
    return { channelId };
  }

  private isLikelyGroupConversation(channelId: string): boolean {
    return !(channelId.startsWith('D') || channelId.startsWith('U'));
  }

  private async resolveUserName(userId: string | undefined): Promise<string> {
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

  private async resolveChannelName(channelId: string): Promise<string> {
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

  private async writeFetchResponseToFile(
    response: Response,
    destPath: string,
  ): Promise<boolean> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > SLACK_MAX_ATTACHMENT_BYTES
    ) {
      logger.warn(
        { declaredLength, maxBytes: SLACK_MAX_ATTACHMENT_BYTES },
        'Slack file exceeds max allowed size',
      );
      return false;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > SLACK_MAX_ATTACHMENT_BYTES) {
        logger.warn(
          { bytes: buffer.byteLength, maxBytes: SLACK_MAX_ATTACHMENT_BYTES },
          'Slack file exceeds max allowed size',
        );
        return false;
      }
      fs.writeFileSync(destPath, buffer);
      return true;
    }

    const fd = fs.openSync(destPath, 'w');
    let totalBytes = 0;
    let shouldCleanup = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        if (!value || value.byteLength === 0) continue;
        totalBytes += value.byteLength;
        if (totalBytes > SLACK_MAX_ATTACHMENT_BYTES) {
          shouldCleanup = true;
          logger.warn(
            { bytes: totalBytes, maxBytes: SLACK_MAX_ATTACHMENT_BYTES },
            'Slack file exceeds max allowed size',
          );
          return false;
        }
        fs.writeSync(fd, Buffer.from(value));
      }
      return true;
    } catch {
      shouldCleanup = true;
      throw new Error('Failed to stream Slack attachment');
    } finally {
      fs.closeSync(fd);
      if (shouldCleanup) {
        try {
          fs.unlinkSync(destPath);
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }

  private sanitizeFilename(raw: string): string {
    const trimmed = raw.trim();
    const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
    return safe || 'attachment.bin';
  }

  private async downloadSlackAttachment(
    jid: string,
    file: {
      name?: string;
      title?: string;
      url_private?: string;
      url_private_download?: string;
    },
  ): Promise<string | null> {
    const url = file.url_private_download || file.url_private;
    if (!url) return null;

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      return url;
    }

    const filename = this.sanitizeFilename(
      file.name || file.title || 'attachment.bin',
    );
    const groupDir = resolveGroupFolderPath(group.folder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const destPath = path.join(attachDir, filename);

    try {
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
        return url;
      }

      const wrote = await this.writeFetchResponseToFile(resp, destPath);
      if (!wrote) return url;
      return `/workspace/group/attachments/${filename}`;
    } catch (err) {
      logger.warn({ jid, err, filename }, 'Slack attachment download failed');
      return url;
    }
  }

  private async enrichMessageText(
    jid: string,
    event: SlackMessageLike,
  ): Promise<string> {
    const lines: string[] = [];
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (text) lines.push(text);

    if (Array.isArray(event.files)) {
      for (const file of event.files) {
        const location = await this.downloadSlackAttachment(jid, file);
        if (!location) continue;
        const label = file.name || file.title || 'attachment';
        lines.push(`Attachment: ${label} (${location})`);
      }
    }

    return lines.join('\n').trim();
  }

  private async ingestSlackMessage(event: SlackMessageLike): Promise<void> {
    if (!event.channel || !event.ts) return;
    if (event.bot_id) return;
    if (event.subtype && event.subtype !== 'file_share') return;
    if (event.subtype === 'message_changed') return;
    if (event.edited) return;

    const jid = `sl:${event.channel}`;
    const content = await this.enrichMessageText(jid, event);
    if (!content) return;

    const sender = event.user || 'unknown';
    const senderName = await this.resolveUserName(event.user);
    const chatName = await this.resolveChannelName(event.channel);

    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      chatName,
      'slack',
      this.isLikelyGroupConversation(event.channel),
    );

    this.opts.onMessage(jid, {
      id: event.client_msg_id || event.ts,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content,
      timestamp: new Date(Math.round(Number(event.ts) * 1000)).toISOString(),
      is_from_me: this.botUserId ? sender === this.botUserId : false,
      thread_id: event.thread_ts || undefined,
      reply_to_message_id:
        event.thread_ts && event.thread_ts !== event.ts
          ? event.thread_ts
          : undefined,
    });
  }

  private async tryNativeStreamStart(
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

  private async tryNativeStreamAppend(
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

  private async tryNativeStreamStop(
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

  private canDecidePermission(userId: string): boolean {
    if (SLACK_PERMISSION_APPROVER_IDS.size === 0) return true;
    return SLACK_PERMISSION_APPROVER_IDS.has(userId);
  }

  private formatPermissionPromptText(
    request: PermissionApprovalRequest,
    timeoutMs: number,
  ): string {
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
    const lines = [
      `Permission request: ${request.requestId}`,
      `Tool: ${request.displayName || request.toolName}`,
      `Source: ${request.sourceGroup}`,
    ];
    if (request.title) lines.push(`Action: ${request.title}`);
    if (request.blockedPath) lines.push(`Path: ${request.blockedPath}`);
    if (request.decisionReason) lines.push(`Reason: ${request.decisionReason}`);
    if (request.description) lines.push(`Details: ${request.description}`);
    lines.push(...this.formatPermissionToolInputLines(request));
    lines.push(`Reply timeout: ${timeoutMinutes} minute(s)`);
    return lines.join('\n');
  }

  private async resolvePermissionPrompt(
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

    const status = decision.approved ? 'APPROVED' : 'DENIED';
    const actor = decision.decidedBy || 'unknown';
    const reason = decision.reason ? ` (${decision.reason})` : '';
    const text = `Permission request ${requestId}\nStatus: ${status} by ${actor}${reason}`;

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

  private registerBoltHandlers(): void {
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
        user?: { id?: string; name?: string; username?: string };
      };
      const action = args.action as { value?: string };
      const userId = body.user?.id || '';
      if (!action.value || !userId) return;

      let payload:
        | {
            requestId: string;
            decision: 'approve' | 'deny';
          }
        | undefined;
      try {
        payload = JSON.parse(action.value) as {
          requestId: string;
          decision: 'approve' | 'deny';
        };
      } catch {
        return;
      }
      if (!payload?.requestId) return;

      const pending = this.pendingPermissionPrompts.get(payload.requestId);
      if (!pending) return;

      if (!this.canDecidePermission(userId)) {
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
      await this.resolvePermissionPrompt(payload.requestId, {
        approved: payload.decision === 'approve',
        decidedBy,
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
      if (!this.canDecidePermission(userId)) {
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
      if (!this.canDecidePermission(userId)) {
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

  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
    });

    this.registerBoltHandlers();

    this.app.error(async (error: Error) => {
      logger.error({ err: error }, 'Slack app error');
    });

    await this.app.start();
    try {
      const auth = (await this.app.client.auth.test()) as {
        ok?: boolean;
        user_id?: string;
        user?: string;
        team?: string;
      };
      this.botUserId = auth.user_id || auth.user || null;
      logger.info(
        { team: auth.team, botUserId: this.botUserId },
        'Slack Socket Mode connected',
      );
    } catch (err) {
      logger.warn({ err }, 'Slack auth.test failed after Socket Mode start');
    }
  }

  async sendMessage(
    jid: string,
    text: string,
    options: MessageSendOptions = {},
  ): Promise<void> {
    if (!this.app) return;
    const parsed = this.parseJid(jid);
    if (!parsed) return;

    const formatted = formatOutboundForChannel(text, 'slack');
    if (!formatted) return;

    await this.app.client.chat.postMessage({
      channel: parsed.channelId,
      text: formatted,
      ...(options.threadId ? { thread_ts: options.threadId } : {}),
    });
  }

  async sendStreamingChunk(
    jid: string,
    text: string,
    options: StreamingChunkOptions = {},
  ): Promise<void> {
    if (!this.app) return;
    const parsed = this.parseJid(jid);
    if (!parsed) return;
    if (!this.shouldAcceptStreamingChunk(jid, options.generation)) return;

    const key = this.streamKey(jid, options.threadId);
    let state = this.activeStreams.get(key);
    if (!state) {
      state = {
        channelId: parsed.channelId,
        threadId: options.threadId,
        rawBuffer: '',
        lastSentText: '',
        lastNativeText: '',
        nativeEnabled: true,
        lastFlushAt: 0,
      };
      this.activeStreams.set(key, state);
    }

    if (text) state.rawBuffer += text;

    const rendered = formatOutboundForChannel(
      stripInternalTagsPreserveWhitespace(state.rawBuffer),
      'slack',
    );

    if (!rendered && options.done) {
      this.activeStreams.delete(key);
      this.markStreamingGenerationDone(jid, options.generation);
      return;
    }

    const now = Date.now();
    const hasMessageHandle = Boolean(state.messageTs || state.nativeStreamTs);
    const shouldFlush =
      options.done ||
      !hasMessageHandle ||
      now - state.lastFlushAt >= SLACK_STREAM_UPDATE_INTERVAL_MS;
    if (!shouldFlush) return;

    let nextText = rendered;
    if (!nextText) nextText = state.lastSentText;

    try {
      let startedNativeThisFlush = false;
      if (state.nativeEnabled && !state.nativeStreamTs && nextText) {
        state.nativeStreamTs = await this.tryNativeStreamStart(
          state.channelId,
          state.threadId,
          nextText,
        );
        if (state.nativeStreamTs) {
          // Initial content is already sent via startStream; avoid appending
          // the same content again on this same flush.
          state.lastNativeText = nextText;
          state.lastSentText = nextText;
          startedNativeThisFlush = true;
        } else {
          state.nativeEnabled = false;
        }
      }

      if (state.nativeEnabled && state.nativeStreamTs) {
        const delta = startedNativeThisFlush
          ? ''
          : nextText.startsWith(state.lastSentText)
            ? nextText.slice(state.lastSentText.length)
            : nextText;
        if (delta) {
          const appended = await this.tryNativeStreamAppend(
            state.channelId,
            state.nativeStreamTs,
            delta,
          );
          if (!appended) {
            state.nativeEnabled = false;
          } else {
            state.lastNativeText = nextText;
          }
        }
        if (options.done && state.nativeEnabled) {
          const stopped = await this.tryNativeStreamStop(
            state.channelId,
            state.nativeStreamTs,
          );
          if (!stopped) state.nativeEnabled = false;
        }
      }

      if (!this.isCurrentStreamingGeneration(jid, options.generation)) return;
      if (!state.nativeEnabled) {
        const fallbackText =
          state.lastNativeText && nextText.startsWith(state.lastNativeText)
            ? nextText.slice(state.lastNativeText.length)
            : nextText;
        if (!state.messageTs) {
          if (fallbackText) {
            const posted = (await this.app.client.chat.postMessage({
              channel: state.channelId,
              text: fallbackText,
              ...(state.threadId ? { thread_ts: state.threadId } : {}),
            })) as { ts?: string };
            state.messageTs = posted.ts;
          }
        } else if (fallbackText) {
          await this.app.client.chat.update({
            channel: state.channelId,
            ts: state.messageTs,
            text: fallbackText,
          });
        }
      }

      state.lastSentText = nextText;
      state.lastFlushAt = now;
    } catch (err) {
      logger.warn(
        { jid, err },
        'Slack streaming update failed; preserving current stream state',
      );
    }

    if (options.done) {
      this.activeStreams.delete(key);
      this.markStreamingGenerationDone(jid, options.generation);
    } else {
      this.activeStreams.set(key, state);
    }
  }

  resetStreaming(jid: string): void {
    this.sealStreamingGenerationOnReset(jid);
    this.clearStreamingStateForJid(jid);
  }

  async sendProgressUpdate(
    jid: string,
    text: string,
    options: ProgressUpdateOptions = {},
  ): Promise<void> {
    if (!this.app) return;
    const parsed = this.parseJid(jid);
    if (!parsed) return;

    const trimmed = text.trim();
    if (!trimmed) return;

    if (options.threadId) {
      try {
        await this.app.client.apiCall('assistant.threads.setStatus', {
          channel_id: parsed.channelId,
          thread_ts: options.threadId,
          status: trimmed,
        });
      } catch {
        // Optional surface; fall through to message-based progress.
      }
    }

    const key = this.progressKey(jid, options.threadId);
    const existing = this.activeProgress.get(key);

    if (!existing) {
      const sent = (await this.app.client.chat.postMessage({
        channel: parsed.channelId,
        text: trimmed,
        ...(options.threadId ? { thread_ts: options.threadId } : {}),
      })) as { ts?: string };

      if (!options.done) {
        this.activeProgress.set(key, {
          channelId: parsed.channelId,
          threadId: options.threadId,
          messageTs: sent.ts,
          lastText: trimmed,
        });
      }
      return;
    }

    if (existing.lastText === trimmed) {
      if (options.done) this.activeProgress.delete(key);
      return;
    }

    if (existing.messageTs) {
      await this.app.client.chat.update({
        channel: existing.channelId,
        ts: existing.messageTs,
        text: trimmed,
      });
    } else {
      const sent = (await this.app.client.chat.postMessage({
        channel: existing.channelId,
        text: trimmed,
        ...(existing.threadId ? { thread_ts: existing.threadId } : {}),
      })) as { ts?: string };
      existing.messageTs = sent.ts;
    }

    existing.lastText = trimmed;
    if (options.done) {
      this.activeProgress.delete(key);
    } else {
      this.activeProgress.set(key, existing);
    }
  }

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> {
    if (!this.app) {
      return { approved: false, reason: 'Slack app is not connected' };
    }

    const parsed = this.parseJid(jid);
    if (!parsed) {
      return { approved: false, reason: 'Invalid Slack JID' };
    }

    if (this.pendingPermissionPrompts.has(request.requestId)) {
      return {
        approved: false,
        reason: `Duplicate pending request: ${request.requestId}`,
      };
    }

    const timeoutMs = PERMISSION_APPROVAL_TIMEOUT_MS;
    const promptText = this.formatPermissionPromptText(request, timeoutMs);

    try {
      const response = (await this.app.client.chat.postMessage({
        channel: parsed.channelId,
        text: promptText,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: promptText,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                action_id: 'myclaw_perm_decision',
                text: {
                  type: 'plain_text',
                  text: 'Approve',
                },
                style: 'primary',
                value: JSON.stringify({
                  requestId: request.requestId,
                  decision: 'approve',
                }),
              },
              {
                type: 'button',
                action_id: 'myclaw_perm_decision',
                text: {
                  type: 'plain_text',
                  text: 'Deny',
                },
                style: 'danger',
                value: JSON.stringify({
                  requestId: request.requestId,
                  decision: 'deny',
                }),
              },
            ],
          },
        ],
      })) as { ts?: string };

      const messageTs = response.ts;
      if (!messageTs) {
        return {
          approved: false,
          reason:
            'Slack did not return a message timestamp for approval prompt',
        };
      }

      return await new Promise<PermissionApprovalDecision>((resolve) => {
        const timer = setTimeout(() => {
          void this.resolvePermissionPrompt(request.requestId, {
            approved: false,
            decidedBy: 'system',
            reason: 'timed out',
          });
        }, timeoutMs);

        this.pendingPermissionPrompts.set(request.requestId, {
          channelId: parsed.channelId,
          messageTs,
          timer,
          resolve,
          settled: false,
        });
      });
    } catch (err) {
      logger.error(
        { jid, requestId: request.requestId, err },
        'Failed to send Slack permission prompt',
      );
      return {
        approved: false,
        reason: 'Failed to send approval prompt to Slack',
      };
    }
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
    if (!this.app) {
      return { requestId: request.requestId, answers: {} };
    }

    const parsed = this.parseJid(jid);
    if (!parsed) {
      return { requestId: request.requestId, answers: {} };
    }

    const timeoutMs = PERMISSION_APPROVAL_TIMEOUT_MS;
    const answers: Record<string, string | string[]> = {};
    let answeredBy: string | undefined;

    for (let i = 0; i < request.questions.length; i += 1) {
      const question = request.questions[i];
      const pendingKey = this.pendingUserQuestionKey(request.requestId, i);
      if (this.pendingUserQuestions.has(pendingKey)) {
        logger.warn(
          { requestId: request.requestId, questionIndex: i },
          'Duplicate pending Slack user question request detected',
        );
        continue;
      }

      const promptText = this.formatUserQuestionPromptText(question, timeoutMs);

      try {
        const pendingState: PendingUserQuestionState = {
          requestId: request.requestId,
          questionIndex: i,
          question,
          promptText,
          selectedOptionIndexes: new Set<number>(),
          channelId: parsed.channelId,
          messageTs: '',
          resolve: () => undefined,
          settled: false,
        };

        const sent = (await this.app.client.chat.postMessage({
          channel: parsed.channelId,
          text: promptText,
          blocks: this.buildUserQuestionBlocks(pendingState) as any,
        })) as { ts?: string };

        const messageTs = sent.ts;
        if (!messageTs) {
          logger.warn(
            { requestId: request.requestId, questionIndex: i },
            'Slack did not return a message timestamp for user question prompt',
          );
          continue;
        }

        const selection = await new Promise<{
          selected: string | string[];
          answeredBy?: string;
        }>((resolve) => {
          const timer = setTimeout(() => {
            const timedOut = this.pendingUserQuestions.get(pendingKey);
            if (!timedOut) return;
            // Fire-and-forget is intentional: timer callback should never block
            // while we cleanup stale pending prompts.
            void this.finalizeUserQuestionPrompt(
              timedOut,
              timedOut.question.multiSelect ? [] : '',
              'system',
              'timed out',
            );
          }, timeoutMs);

          this.pendingUserQuestions.set(pendingKey, {
            ...pendingState,
            messageTs,
            timer,
            resolve,
          });
        });

        const isEmptySelection = Array.isArray(selection.selected)
          ? selection.selected.length === 0
          : selection.selected.trim().length === 0;
        if (isEmptySelection) {
          // Timeout or explicit empty submission: omit this answer so the SDK
          // receives an empty answer map and treats it as unanswered/declined.
          continue;
        }

        if (selection.answeredBy) answeredBy = selection.answeredBy;
        answers[question.question] = selection.selected;
      } catch (err) {
        logger.warn(
          { requestId: request.requestId, questionIndex: i, err },
          'Failed to run Slack user question prompt',
        );
      }
    }

    return {
      requestId: request.requestId,
      answers,
      ...(answeredBy ? { answeredBy } : {}),
    };
  }

  async syncGroups(force = false): Promise<void> {
    if (!this.app) return;

    const now = new Date().toISOString();
    let cursor: string | undefined;

    do {
      const page = (await this.app.client.conversations.list({
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })) as {
        channels?: Array<{ id?: string; name?: string; is_im?: boolean }>;
        response_metadata?: { next_cursor?: string };
      };

      const channels = Array.isArray(page.channels) ? page.channels : [];
      for (const channel of channels) {
        const channelId = channel.id;
        if (!channelId) continue;
        if (!force && this.channelNameCache.has(channelId)) continue;
        const name = channel.name || (await this.resolveChannelName(channelId));
        this.channelNameCache.set(channelId, name);

        this.opts.onChatMetadata(
          `sl:${channelId}`,
          now,
          name,
          'slack',
          !channel.is_im,
        );
      }

      const nextCursor = page.response_metadata?.next_cursor?.trim() || '';
      cursor = nextCursor || undefined;
    } while (cursor);
  }

  isConnected(): boolean {
    return this.app !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sl:');
  }

  async disconnect(): Promise<void> {
    for (const [
      requestId,
      pending,
    ] of this.pendingPermissionPrompts.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        approved: false,
        decidedBy: 'system',
        reason: 'Slack channel disconnected',
      });
      this.pendingPermissionPrompts.delete(requestId);
    }

    for (const [key, pending] of this.pendingUserQuestions.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({
        selected: pending.question.multiSelect ? [] : '',
        answeredBy: 'system',
      });
      this.pendingUserQuestions.delete(key);
    }

    for (const state of this.activeStreams.values()) {
      if (state.nativeStreamTs) {
        void this.tryNativeStreamStop(state.channelId, state.nativeStreamTs);
      }
    }
    this.activeStreams.clear();
    this.streamGenerationByJid.clear();
    this.sealedStreamGenerationByJid.clear();
    this.activeProgress.clear();

    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Slack does not expose a generic typing indicator API for bot replies.
  }
}

export function createSlackChannel(opts: ChannelOpts): SlackChannel | null {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  const botToken = process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN || '';
  const appToken = process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN || '';

  if (!botToken || !appToken) {
    logger.warn('Slack: SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required');
    return null;
  }

  return new SlackChannel(botToken, appToken, opts);
}
