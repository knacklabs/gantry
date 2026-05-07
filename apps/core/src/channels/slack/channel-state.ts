import fs from 'fs';
import path from 'path';

import { App } from '@slack/bolt';

import { logger } from '../../infrastructure/logging/logger.js';
import {
  PRIVATE_FILE_MODE,
  assertPrivateFileTargetSync,
  ensurePrivateDirSync,
  writePrivateFileSync,
} from '../../shared/private-fs.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../../domain/types.js';
import { resolveGroupFolderPath } from '../../platform/group-folder.js';
import { ChannelOpts } from '../channel-provider.js';

export const SLACK_STREAM_UPDATE_INTERVAL_MS = 900;
export const SLACK_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const SLACK_LIMITS = { buttonText: 75, actionValue: 2000 } as const;

interface SlackAttachmentDownload {
  filePath: string;
  storageRef: string;
}

export interface ActiveStreamState {
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

export interface ActiveProgressState {
  channelId: string;
  threadId?: string;
  messageTs?: string;
  lastText: string;
}

export interface PendingPermissionPrompt {
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
  requestId: string;
  questionIndex: number;
  question: UserQuestionRequest['questions'][number];
  promptText: string;
  selectedOptionIndexes: Set<number>;
  channelId: string;
  sourceAgentFolder: string;
  messageTs: string;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (selection: {
    selected: string | string[];
    answeredBy?: string;
  }) => void;
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
  >;
  protected botUserId: string | null = null;
  protected userNameCache = new Map<string, string>();
  protected channelNameCache = new Map<string, string>();
  protected activeStreams = new Map<string, ActiveStreamState>();
  protected streamGenerationByJid = new Map<string, number>();
  protected sealedStreamGenerationByJid = new Map<string, number>();
  protected activeProgress = new Map<string, ActiveProgressState>();
  protected progressStateLoaded = false;
  protected pendingPermissionPrompts = new Map<
    string,
    PendingPermissionPrompt
  >();
  protected pendingUserQuestions = new Map<string, PendingUserQuestionState>();

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

  protected pendingUserQuestionKey(
    requestId: string,
    questionIndex: number,
  ): string {
    return `${requestId}:${questionIndex}`;
  }

  protected truncateText(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen)}...`;
  }

  protected truncateButtonText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return 'Option';
    return this.truncateText(trimmed, SLACK_LIMITS.buttonText);
  }

  protected encodeActionValue(value: Record<string, unknown>): string {
    const serialized = JSON.stringify(value);
    if (serialized.length <= SLACK_LIMITS.actionValue) {
      return serialized;
    }
    return JSON.stringify({
      requestId: value.requestId,
      questionIndex: value.questionIndex,
    });
  }

  protected formatPermissionToolInputLines(
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

  protected formatUserQuestionPromptText(
    request: UserQuestionRequest,
    question: UserQuestionRequest['questions'][number],
    timeoutMs: number,
  ): string {
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60000));
    const lines = [
      `*${question.header}*`,
      `Source: ${this.truncateText(request.sourceAgentFolder, 80)}`,
    ];
    if (request.threadId) {
      lines.push(`Thread: ${this.truncateText(request.threadId, 80)}`);
    }
    lines.push(question.question, '');
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

  protected parseUserQuestionActionValue(
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

  protected clearStreamingStateForJid(jid: string): void {
    for (const [key, state] of this.activeStreams.entries()) {
      if (!key.startsWith(`${jid}:`)) continue;
      if (state.nativeStreamTs) {
        void this.tryNativeStreamStop(state.channelId, state.nativeStreamTs);
      }
      this.activeStreams.delete(key);
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

  protected async writeFetchResponseToFile(
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
      writePrivateFileSync(destPath, buffer);
      return true;
    }

    assertPrivateFileTargetSync(destPath);
    const fd = fs.openSync(destPath, 'w', PRIVATE_FILE_MODE);
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
    } catch (err) {
      shouldCleanup = true;
      throw new Error('Failed to stream Slack attachment', { cause: err });
    } finally {
      fs.closeSync(fd);
      if (shouldCleanup) {
        try {
          fs.unlinkSync(destPath);
        } catch {
          // ignore cleanup failures
        }
      } else {
        fs.chmodSync(destPath, PRIVATE_FILE_MODE);
      }
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
  ): Promise<SlackAttachmentDownload | null> {
    const url = file.url_private_download || file.url_private;
    if (!url) return null;

    const group = this.opts.conversationRoutes()[jid];
    if (!group) {
      return null;
    }

    const filename = this.sanitizeFilename(
      file.name || file.title || 'attachment.bin',
    );
    const groupDir = resolveGroupFolderPath(group.folder);
    const attachDir = path.join(groupDir, 'attachments');
    ensurePrivateDirSync(attachDir);
    const destPath = path.join(attachDir, filename);
    const storageRef = path.posix.join('attachments', filename);

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
        return null;
      }

      const wrote = await this.writeFetchResponseToFile(resp, destPath);
      if (!wrote) return null;
      return { filePath: destPath, storageRef };
    } catch (err) {
      logger.warn({ jid, err, filename }, 'Slack attachment download failed');
      return null;
    }
  }

  protected async enrichMessage(
    jid: string,
    event: SlackMessageLike,
  ): Promise<{
    text: string;
    attachments: NonNullable<
      import('../../domain/types.js').NewMessage['attachments']
    >;
  }> {
    const lines: string[] = [];
    const attachments: NonNullable<
      import('../../domain/types.js').NewMessage['attachments']
    > = [];
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (text) lines.push(text);

    if (Array.isArray(event.files)) {
      for (const file of event.files) {
        const download = await this.downloadSlackAttachment(jid, file);
        const label = file.name || file.title || 'attachment';
        lines.push(`Attachment: ${label}`);
        attachments.push({
          id: file.id ? `slack-file:${file.id}` : undefined,
          kind: file.mimetype?.startsWith('image/') ? 'image' : 'file',
          contentType: file.mimetype,
          externalId: file.id,
          storageRef: download?.storageRef,
        });
      }
    }

    return { text: lines.join('\n').trim(), attachments };
  }
  protected abstract tryNativeStreamStop(
    channelId: string,
    streamTs: string,
  ): Promise<boolean>;
}
