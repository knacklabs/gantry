import fs from 'fs';
import path from 'path';

import { App } from '@slack/bolt';

import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../config/index.js';
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
  permissionButtonLabel,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import {
  channelProgressStateFilePath,
  readProgressStateEntries,
  writeProgressStateEntries,
} from '../progress-state-file.js';

import { SlackChannelInteractions } from './channel-interactions.js';
import {
  SLACK_STREAM_UPDATE_INTERVAL_MS,
  ActiveProgressState,
  PendingUserQuestionState,
} from './channel-state.js';

export abstract class SlackChannelDelivery extends SlackChannelInteractions {
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
  ): Promise<{ externalMessageId?: string } | void> {
    if (!this.app) return;
    const parsed = this.parseJid(jid);
    if (!parsed) return;

    const formatted = formatOutboundForChannel(text, 'slack');
    if (!formatted) return;

    const posted = (await this.app.client.chat.postMessage({
      channel: parsed.channelId,
      text: formatted,
      ...(options.threadId ? { thread_ts: options.threadId } : {}),
    })) as { ts?: string };
    return posted.ts ? { externalMessageId: posted.ts } : {};
  }

  async sendStreamingChunk(
    jid: string,
    text: string,
    options: StreamingChunkOptions = {},
  ): Promise<boolean> {
    if (!this.app) return false;
    const parsed = this.parseJid(jid);
    if (!parsed) return false;
    if (!this.shouldAcceptStreamingChunk(jid, options.generation)) return false;

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
      return false;
    }

    const now = Date.now();
    const hasMessageHandle = Boolean(state.messageTs || state.nativeStreamTs);
    const shouldFlush =
      options.done ||
      !hasMessageHandle ||
      now - state.lastFlushAt >= SLACK_STREAM_UPDATE_INTERVAL_MS;
    if (!shouldFlush) {
      return Boolean(state.messageTs || state.nativeStreamTs);
    }

    let nextText = rendered;
    if (!nextText) nextText = state.lastSentText;
    let delivered = false;

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
          delivered = true;
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
            delivered = true;
          }
        }
        if (options.done && state.nativeEnabled) {
          const stopped = await this.tryNativeStreamStop(
            state.channelId,
            state.nativeStreamTs,
          );
          if (!stopped) state.nativeEnabled = false;
          if (stopped) delivered = true;
        }
      }

      if (!this.isCurrentStreamingGeneration(jid, options.generation)) {
        return delivered;
      }
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
            delivered = true;
          }
        } else if (fallbackText) {
          await this.app.client.chat.update({
            channel: state.channelId,
            ts: state.messageTs,
            text: fallbackText,
          });
          delivered = true;
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
    return delivered || Boolean(state.messageTs || state.nativeStreamTs);
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
    const key = this.progressKey(jid, options.threadId);
    this.loadPersistedProgress();
    if (!trimmed) {
      if (options.done) {
        this.activeProgress.delete(key);
        this.persistProgress();
      }
      return;
    }

    const existing = this.activeProgress.get(key);
    if (!existing && options.replaceOnly) return;

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
        this.persistProgress();
      }
      return;
    }

    if (existing.lastText === trimmed) {
      if (options.done) {
        this.activeProgress.delete(key);
        this.persistProgress();
      }
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
    this.persistProgress();
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
        ...(request.threadId ? { thread_ts: request.threadId } : {}),
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
            elements: permissionDecisionOptions(request).map((mode) => ({
              type: 'button',
              action_id: 'myclaw_perm_decision',
              text: {
                type: 'plain_text',
                text: permissionButtonLabel(mode, request),
              },
              ...(mode === 'cancel'
                ? { style: 'danger' as const }
                : { style: 'primary' as const }),
              value: JSON.stringify({
                requestId: request.requestId,
                decision: mode,
              }),
            })),
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
          sourceGroup: request.sourceGroup,
          decisionPolicy: request.decisionPolicy,
          approvalContextJid: request.approvalContextJid,
          request,
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

  private loadPersistedProgress(): void {
    if (this.progressStateLoaded) return;
    this.progressStateLoaded = true;
    const entries = readProgressStateEntries(
      channelProgressStateFilePath('slack', this.botToken),
      'Slack',
    ) as unknown as Array<[string, ActiveProgressState]>;
    for (const [key, state] of entries) {
      if (
        typeof state.channelId === 'string' &&
        typeof state.lastText === 'string'
      ) {
        this.activeProgress.set(key, state);
      }
    }
  }

  private persistProgress(): void {
    writeProgressStateEntries(
      channelProgressStateFilePath('slack', this.botToken),
      'Slack',
      this.activeProgress.entries(),
    );
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

      const promptText = this.formatUserQuestionPromptText(
        request,
        question,
        timeoutMs,
      );

      try {
        const pendingState: PendingUserQuestionState = {
          requestId: request.requestId,
          questionIndex: i,
          question,
          promptText,
          selectedOptionIndexes: new Set<number>(),
          channelId: parsed.channelId,
          sourceGroup: request.sourceGroup,
          messageTs: '',
          resolve: () => undefined,
          settled: false,
        };

        const sent = (await this.app.client.chat.postMessage({
          channel: parsed.channelId,
          text: promptText,
          ...(request.threadId ? { thread_ts: request.threadId } : {}),
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

        await this.opts.onChatMetadata(
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
