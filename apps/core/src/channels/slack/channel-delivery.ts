import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  RichInteractionRequest,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import {
  getPartialMessageDeliveryMetadata,
  isPartialMessageDeliveryError,
} from '../../domain/messages/partial-delivery.js';
import {
  formatOutboundForChannel,
  stripInternalTagsPreserveWhitespace,
} from '../../messaging/router.js';
import {
  disconnectSlackDelivery,
  loadPersistedSlackProgress,
  persistSlackProgress,
  sendSlackFallbackStreamParts,
  sendSlackMessage,
  sendSlackProgressUpdate,
  syncSlackGroups,
  type SlackSnippetFallbackInput,
  type SlackSnippetFallbackResult,
} from './channel-delivery-helpers.js';
import { SlackChannelInteractions } from './channel-interactions.js';
import {
  SLACK_FALLBACK_CHUNK_MAX_LENGTH,
  SLACK_STREAM_UPDATE_INTERVAL_MS,
  splitSlackTextByCodeUnits,
} from './text-limits.js';
import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { renderSlackAgentTodo } from './agent-todo-delivery.js';
import { connectSlackApp } from './channel-connect.js';
import {
  requestSlackPermissionApproval,
  slackPermissionApproverIds,
} from './permission-approval-delivery.js';
import { renderSlackRichInteraction } from './rich-interaction.js';
import { addSlackReaction } from './reactions.js';
import { requestSlackUserAnswer } from './user-question-delivery.js';
const SLACK_STREAM_SNIPPET_FALLBACK_MIN_PARTS = 4;

export abstract class SlackChannelDelivery extends SlackChannelInteractions {
  private interactionCallbacksEnabled = true;
  private readonly reactionKeys = new Set<string>();
  protected async sendSnippetFallback(
    _input: SlackSnippetFallbackInput,
  ): Promise<SlackSnippetFallbackResult | null> {
    return null;
  }
  async connect(
    options: { inbound?: boolean; interactionCallbacks?: boolean } = {},
  ): Promise<void> {
    const inboundEnabled = options.inbound !== false;
    const interactionCallbacksEnabled =
      options.interactionCallbacks ?? inboundEnabled;
    this.interactionCallbacksEnabled = interactionCallbacksEnabled;
    const connected = await connectSlackApp({
      botToken: this.botToken,
      appToken: this.appToken,
      inboundEnabled,
      interactionCallbacksEnabled,
      registerBoltHandlers: (app) => {
        this.app = app;
        this.registerBoltHandlers({ inbound: inboundEnabled });
      },
    });
    this.app = connected.app;
    this.botUserId = connected.botUserId;
  }
  supportsInteractionCallbacks(): boolean {
    return this.interactionCallbacksEnabled;
  }
  async sendMessage(
    jid: string,
    text: string,
    options: MessageSendOptions = {},
  ): Promise<MessageDeliveryResult | void> {
    if (!this.app) return;
    const parsed = this.parseJid(jid);
    if (!parsed) return;

    return sendSlackMessage({
      app: this.app,
      jid,
      channelId: parsed.channelId,
      formattedText: formatOutboundForChannel(text, 'slack'),
      options: {
        ...options,
        providerAccountId:
          options.providerAccountId ?? this.opts.providerAccountId,
      },
      log: logger,
      sendSnippetFallback: (fallback) => this.sendSnippetFallback(fallback),
    });
  }

  async addReaction(
    jid: string,
    messageRef: string,
    emoji: string,
  ): Promise<void> {
    if (!this.app) return;
    const parsed = this.parseJid(jid);
    if (!parsed) return;
    await addSlackReaction({
      app: this.app,
      jid,
      channelId: parsed.channelId,
      messageRef,
      emoji,
      reactionKeys: this.reactionKeys,
    });
  }

  async renderAgentTodo(
    jid: string,
    render: AgentTodoRender,
  ): Promise<boolean> {
    if (!this.app) return false;
    const parsed = this.parseJid(jid);
    if (!parsed) return false;
    const todoKey = this.streamKey(
      `${jid}:${render.cardKind ?? 'todo'}`,
      render.threadId ?? undefined,
    );
    return renderSlackAgentTodo({
      app: this.app,
      jid,
      channelId: parsed.channelId,
      render,
      providerAccountId: this.opts.providerAccountId,
      todoKey,
      pendingTodos: this.pendingTodos,
    });
  }

  async renderRichInteraction(
    jid: string,
    render: RichInteractionRequest,
  ): Promise<boolean> {
    if (!this.app) return false;
    const parsed = this.parseJid(jid);
    if (!parsed) return false;
    return renderSlackRichInteraction({
      app: this.app,
      jid,
      channelId: parsed.channelId,
      render,
      pendingRichForms: this.pendingRichForms,
      sendFallback: (text, options) => this.sendMessage(jid, text, options),
    });
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
    const streamEpoch = this.streamResetEpochs.current(key);
    let state = this.activeStreams.get(key);
    if (!state) {
      state = {
        channelId: parsed.channelId,
        threadId: options.threadId,
        rawBuffer: '',
        lastSentText: '',
        lastNativeText: '',
        fallbackMessageTs: [],
        nativeEnabled: true,
        lastFlushAt: 0,
      };
      this.activeStreams.set(key, state);
    }
    const sendFallbackParts = (fallbackParts: string[]) =>
      sendSlackFallbackStreamParts({
        app: this.app,
        jid,
        state,
        fallbackParts,
        log: logger,
        shouldContinue: () =>
          this.streamResetEpochs.isCurrent(key, streamEpoch),
      });
    if (text) state.rawBuffer += text;
    const rendered = formatOutboundForChannel(
      stripInternalTagsPreserveWhitespace(state.rawBuffer),
      'slack',
    );
    if (!rendered && options.done) {
      this.streamResetEpochs.deleteState(key, this.activeStreams);
      this.markStreamingGenerationDone(jid, options.generation);
      return false;
    }
    const now = currentTimeMs();
    const hasMessageHandle = Boolean(state.messageTs || state.nativeStreamTs);
    const shouldFlush =
      options.done ||
      !hasMessageHandle ||
      now - state.lastFlushAt >= SLACK_STREAM_UPDATE_INTERVAL_MS;
    if (!shouldFlush) return Boolean(state.messageTs || state.nativeStreamTs);
    let nextText = rendered;
    if (!nextText) nextText = state.lastSentText;
    let delivered = false;
    let stopNativeStreamOnDoneAfterFallback = false;
    try {
      let startedNativeThisFlush = false;
      if (state.nativeEnabled && !state.nativeStreamTs && nextText) {
        const nativeStreamTs = await this.tryNativeStreamStart(
          state.channelId,
          state.threadId,
          nextText,
        );
        if (!this.streamResetEpochs.isCurrent(key, streamEpoch)) {
          if (nativeStreamTs)
            await this.tryNativeStreamStop(state.channelId, nativeStreamTs);
          return false;
        }
        state.nativeStreamTs = nativeStreamTs;
        if (state.nativeStreamTs) {
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
          const appendResult = await this.tryNativeStreamAppend(
            state.channelId,
            state.nativeStreamTs,
            delta,
          );
          if (appendResult.sentPrefix) {
            state.lastNativeText += appendResult.sentPrefix;
            delivered = true;
          }
          if (!appendResult.completed) {
            state.nativeEnabled = false;
            if (options.done && state.nativeStreamTs) {
              stopNativeStreamOnDoneAfterFallback = true;
            }
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
        const fallbackTextRaw =
          state.lastNativeText && nextText.startsWith(state.lastNativeText)
            ? nextText.slice(state.lastNativeText.length)
            : nextText;
        const fallbackParts = splitSlackTextByCodeUnits(
          fallbackTextRaw,
          SLACK_FALLBACK_CHUNK_MAX_LENGTH,
        );
        if (
          options.done &&
          fallbackParts.length >= SLACK_STREAM_SNIPPET_FALLBACK_MIN_PARTS
        ) {
          if (!this.streamResetEpochs.isCurrent(key, streamEpoch)) return false;
          const fallback = await this.sendSnippetFallback({
            channelId: state.channelId,
            text: fallbackTextRaw,
            threadId: state.threadId,
            reason: 'stream_output_too_large',
          });
          if (!this.streamResetEpochs.isCurrent(key, streamEpoch)) return false;
          if (fallback) {
            delivered = true;
            state.fallbackMessageTs = [];
          }
        }
        if (!delivered && fallbackParts.length > 0) {
          await sendFallbackParts(fallbackParts);
          delivered = true;
        }
      }

      state.lastSentText = nextText;
      state.lastFlushAt = now;
    } catch (err) {
      if (isPartialMessageDeliveryError(err)) {
        const partialMetadata = getPartialMessageDeliveryMetadata(err);
        const sentPrefix = partialMetadata.sentPrefix ?? '';
        if (sentPrefix.length > 0) {
          const nativeTextWithPrefix = `${state.lastNativeText}${sentPrefix}`;
          if (nextText.startsWith(nativeTextWithPrefix)) {
            state.lastNativeText = nativeTextWithPrefix;
          }
          state.nativeEnabled = false;
        }
        if (options.done && sentPrefix.length > 0) {
          const fallbackTextRaw =
            state.lastNativeText && nextText.startsWith(state.lastNativeText)
              ? nextText.slice(state.lastNativeText.length)
              : nextText;
          const fallbackParts = splitSlackTextByCodeUnits(
            fallbackTextRaw,
            SLACK_FALLBACK_CHUNK_MAX_LENGTH,
          );
          try {
            if (
              fallbackParts.length >= SLACK_STREAM_SNIPPET_FALLBACK_MIN_PARTS
            ) {
              if (!this.streamResetEpochs.isCurrent(key, streamEpoch))
                return false;
              const fallback = await this.sendSnippetFallback({
                channelId: state.channelId,
                text: fallbackTextRaw,
                threadId: state.threadId,
                reason: 'stream_output_too_large',
              });
              if (!this.streamResetEpochs.isCurrent(key, streamEpoch))
                return false;
              if (fallback) {
                delivered = true;
                state.fallbackMessageTs = [];
              }
            }
            if (!delivered && fallbackParts.length > 0) {
              await sendFallbackParts(fallbackParts);
              delivered = true;
            }
            state.lastSentText = nextText;
            state.lastFlushAt = now;
            const ok = this.streamResetEpochs.isCurrent(key, streamEpoch);
            if (ok) this.streamResetEpochs.deleteState(key, this.activeStreams);
            if (ok) this.markStreamingGenerationDone(jid, options.generation);
            return (
              delivered || Boolean(state.messageTs || state.nativeStreamTs)
            );
          } catch (fallbackErr) {
            if (isPartialMessageDeliveryError(fallbackErr)) {
              const fallbackMetadata =
                getPartialMessageDeliveryMetadata(fallbackErr);
              if (!fallbackMetadata.retryTail?.canonicalText) {
                const deliveredParts = fallbackMetadata.deliveredParts;
                if (
                  typeof deliveredParts === 'number' &&
                  Number.isSafeInteger(deliveredParts) &&
                  deliveredParts >= 0 &&
                  deliveredParts < fallbackParts.length
                ) {
                  const unsentTail = fallbackParts
                    .slice(deliveredParts)
                    .join('');
                  if (unsentTail.trim()) {
                    Object.assign(fallbackErr, {
                      retryTail: {
                        canonicalText: unsentTail,
                        providerPayload: {
                          provider: 'slack',
                          channelId: state.channelId,
                          ...(state.threadId
                            ? { threadId: state.threadId }
                            : {}),
                        },
                      },
                    });
                  }
                }
              }
              throw fallbackErr;
            }
            if (fallbackTextRaw.trim()) {
              Object.assign(err, {
                retryTail: {
                  canonicalText: fallbackTextRaw,
                  providerPayload: {
                    provider: 'slack',
                    channelId: state.channelId,
                    ...(state.threadId ? { threadId: state.threadId } : {}),
                  },
                },
              });
            }
            throw err;
          } finally {
            if (state.nativeStreamTs) {
              await this.tryNativeStreamStop(
                state.channelId,
                state.nativeStreamTs,
              );
              state.nativeEnabled = false;
            }
          }
        }
        if (!this.streamResetEpochs.isCurrent(key, streamEpoch)) throw err;
        if (options.done) {
          this.streamResetEpochs.deleteState(key, this.activeStreams);
          this.markStreamingGenerationDone(jid, options.generation);
        } else {
          this.activeStreams.set(key, state);
        }
        throw err;
      }
      logger.warn(
        { jid, err },
        'Slack streaming update failed; preserving current stream state',
      );
    } finally {
      if (
        options.done &&
        stopNativeStreamOnDoneAfterFallback &&
        state.nativeStreamTs
      ) {
        await this.tryNativeStreamStop(state.channelId, state.nativeStreamTs);
        state.nativeEnabled = false;
      }
    }
    if (options.done) {
      if (this.streamResetEpochs.isCurrent(key, streamEpoch)) {
        this.streamResetEpochs.deleteState(key, this.activeStreams);
        this.markStreamingGenerationDone(jid, options.generation);
      }
    } else if (this.streamResetEpochs.isCurrent(key, streamEpoch))
      this.activeStreams.set(key, state);
    return delivered || Boolean(state.messageTs || state.nativeStreamTs);
  }
  resetStreaming(jid: string, options?: { threadId?: string }): void {
    if (options) {
      const key = this.streamKey(jid, options.threadId);
      const state = this.activeStreams.get(key);
      this.streamResetEpochs.bump(key);
      if (state?.nativeStreamTs) {
        void this.tryNativeStreamStop(state.channelId, state.nativeStreamTs);
      }
      this.streamResetEpochs.deleteState(key, this.activeStreams);
      return;
    }
    this.streamResetEpochs.bumpMatching(this.activeStreams.keys(), `${jid}:`);
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
    const key = this.progressKey(jid, options.threadId);
    this.loadPersistedProgress();
    if (options.done) {
      this.markProgressGenerationDone(key, options.generation);
    } else if (
      !this.shouldAcceptProgressUpdate(key, options.generation, options.done)
    ) {
      logger.info(
        {
          channelId: parsed.channelId,
          key,
          progressText: text.trim(),
          generation: options.generation,
        },
        'Progress lifecycle slack dropped sealed generation',
      );
      return;
    }
    await sendSlackProgressUpdate({
      app: this.app,
      channelId: parsed.channelId,
      key,
      text,
      options: {
        ...options,
        providerAccountId:
          options.providerAccountId ?? this.opts.providerAccountId,
      },
      activeProgress: this.activeProgress,
      persistProgress: () => this.persistProgress(),
    });
  }

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalDecision> {
    if (!this.interactionCallbacksEnabled) {
      return {
        approved: false,
        reason: 'This Slack connection cannot collect approvals right now.',
      };
    }
    if (!this.app) {
      return { approved: false, reason: 'Slack app is not connected' };
    }

    const parsed = this.parseJid(jid);
    if (!parsed) {
      return {
        approved: false,
        reason: 'This Slack conversation could not be identified.',
      };
    }

    if (
      Array.from(this.pendingPermissionPrompts.values()).some(
        (pending) =>
          pending.request.requestId === request.requestId &&
          (pending.request.appId || 'default') ===
            (request.appId || 'default') &&
          pending.sourceAgentFolder === request.sourceAgentFolder,
      )
    ) {
      return {
        approved: false,
        reason: 'This approval request is already awaiting a decision.',
      };
    }

    const timeoutMs = PERMISSION_APPROVAL_TIMEOUT_MS;
    return requestSlackPermissionApproval({
      app: this.app,
      jid,
      channelId: parsed.channelId,
      request,
      timeoutMs,
      approverUserIds: slackPermissionApproverIds(
        this.opts.runtimeSettings,
        this.opts.providerAccountId,
        parsed.channelId,
      ),
      pendingPermissionPrompts: this.pendingPermissionPrompts,
      timeoutPermissionPrompt: (providerAlias) =>
        this.timeoutPermissionPrompt(providerAlias),
      onPromptDelivered,
    });
  }

  private loadPersistedProgress(): void {
    if (this.progressStateLoaded) return;
    this.progressStateLoaded = true;
    loadPersistedSlackProgress(this.botToken, this.activeProgress);
  }

  private persistProgress(): void {
    persistSlackProgress(this.botToken, this.activeProgress);
  }

  async requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<UserQuestionResponse> {
    if (!this.interactionCallbacksEnabled) {
      return {
        requestId: request.requestId,
        answers: {},
        answeredBy: 'system',
      };
    }
    if (!this.app) {
      return { requestId: request.requestId, answers: {} };
    }
    const parsed = this.parseJid(jid);
    if (!parsed) {
      return { requestId: request.requestId, answers: {} };
    }
    return requestSlackUserAnswer({
      app: this.app,
      channelId: parsed.channelId,
      request,
      timeoutMs: PERMISSION_APPROVAL_TIMEOUT_MS,
      pendingUserQuestions: this.pendingUserQuestions,
      pendingUserQuestionKey: (callback) =>
        this.pendingUserQuestionKey(callback),
      formatPromptText: (promptRequest, question, timeoutMs) =>
        this.formatUserQuestionPromptText(promptRequest, question, timeoutMs),
      buildBlocks: (pending) => this.buildUserQuestionBlocks(pending),
      finalizeTimedOut: (pending) =>
        this.finalizeUserQuestionPrompt(
          pending,
          pending.question.multiSelect ? [] : '',
          'system',
          'timed out',
        ),
      onPromptDelivered,
    });
  }

  async syncGroups(force = false): Promise<void> {
    await syncSlackGroups({
      app: this.app,
      force,
      channelNameCache: this.channelNameCache,
      resolveChannelName: (channelId) => this.resolveChannelName(channelId),
      onChatMetadata: this.opts.onChatMetadata,
      providerAccountId: this.opts.providerAccountId,
    });
  }
  isConnected(): boolean {
    return this.app !== null;
  }
  ownsJid(jid: string): boolean {
    return jid.startsWith('sl:');
  }
  async disconnect(): Promise<void> {
    this.streamResetEpochs.clear();
    for (const providerAlias of this.pendingPermissionPrompts.keys()) {
      const result = await this.claimAndResolvePermissionPrompt(
        providerAlias,
        'cancel',
        'system',
        undefined,
        'Slack channel disconnected',
        true,
      );
      if (result === 'already_decided') continue;
      const pending = this.pendingPermissionPrompts.get(providerAlias);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pendingPermissionPrompts.delete(providerAlias);
      pending.resolve({
        approved: false,
        mode: 'cancel',
        decidedBy: 'system',
        reason: 'Slack channel disconnected',
      });
    }
    this.app = await disconnectSlackDelivery({
      app: this.app,
      activeStreams: this.activeStreams,
      streamGenerationByJid: this.streamGenerationByJid,
      sealedStreamGenerationByJid: this.sealedStreamGenerationByJid,
      activeProgress: this.activeProgress,
      pendingUserQuestions: this.pendingUserQuestions,
      stopNativeStream: (channelId, streamTs) =>
        this.tryNativeStreamStop(channelId, streamTs),
    });
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {}
}
