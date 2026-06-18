import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
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
  buildPermissionPromptParts,
  permissionButtonLabel,
  permissionDecisionOptions,
} from '../permission-interaction.js';
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
  waitForSlackUserQuestionSelection,
} from './channel-delivery-helpers.js';
import { SlackChannelInteractions } from './channel-interactions.js';
import {
  SLACK_FALLBACK_CHUNK_MAX_LENGTH,
  SLACK_STREAM_UPDATE_INTERVAL_MS,
  splitSlackTextByCodeUnits,
} from './text-limits.js';
import type { PendingUserQuestionState } from './channel-state.js';
import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import { nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';
import { renderSlackAgentTodo } from './agent-todo-delivery.js';
import { connectSlackApp } from './channel-connect.js';
import { requestSlackPermissionApproval } from './permission-approval-delivery.js';
const SLACK_STREAM_SNIPPET_FALLBACK_MIN_PARTS = 4;
export abstract class SlackChannelDelivery extends SlackChannelInteractions {
  private interactionCallbacksEnabled = true;
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
      options,
      log: logger,
      sendSnippetFallback: (fallback) => this.sendSnippetFallback(fallback),
    });
  }

  async renderAgentTodo(jid: string, render: AgentTodoRender): Promise<void> {
    if (!this.app) return;
    const parsed = this.parseJid(jid);
    if (!parsed) return;
    const todoKey = this.streamKey(jid, render.threadId ?? undefined);
    await renderSlackAgentTodo({
      app: this.app,
      jid,
      channelId: parsed.channelId,
      render,
      todoKey,
      pendingTodos: this.pendingTodos,
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

    const now = currentTimeMs();
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
    let stopNativeStreamOnDoneAfterFallback = false;
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
          const fallback = await this.sendSnippetFallback({
            channelId: state.channelId,
            text: fallbackTextRaw,
            threadId: state.threadId,
            reason: 'stream_output_too_large',
          });
          if (fallback) {
            delivered = true;
            state.fallbackMessageTs = [];
          }
        }
        if (!delivered && fallbackParts.length > 0) {
          await sendSlackFallbackStreamParts({
            app: this.app,
            jid,
            state,
            fallbackParts,
            log: logger,
          });
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
              const fallback = await this.sendSnippetFallback({
                channelId: state.channelId,
                text: fallbackTextRaw,
                threadId: state.threadId,
                reason: 'stream_output_too_large',
              });
              if (fallback) {
                delivered = true;
                state.fallbackMessageTs = [];
              }
            }
            if (!delivered && fallbackParts.length > 0) {
              await sendSlackFallbackStreamParts({
                app: this.app,
                jid,
                state,
                fallbackParts,
                log: logger,
              });
              delivered = true;
            }
            state.lastSentText = nextText;
            state.lastFlushAt = now;
            this.activeStreams.delete(key);
            this.markStreamingGenerationDone(jid, options.generation);
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
        if (options.done) {
          this.activeStreams.delete(key);
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
      options,
      activeProgress: this.activeProgress,
      persistProgress: () => this.persistProgress(),
    });
  }

  async requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
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

    if (this.pendingPermissionPrompts.has(request.requestId)) {
      return {
        approved: false,
        reason: 'This approval request is already awaiting a decision.',
      };
    }

    const timeoutMs = PERMISSION_APPROVAL_TIMEOUT_MS;
    const promptText = this.formatPermissionPromptText(request, timeoutMs);
    return requestSlackPermissionApproval({
      app: this.app,
      jid,
      channelId: parsed.channelId,
      request,
      timeoutMs,
      promptText,
      pendingPermissionPrompts: this.pendingPermissionPrompts,
      resolvePermissionPrompt: (requestId, decision) =>
        this.resolvePermissionPrompt(requestId, decision),
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
          sourceAgentFolder: request.sourceAgentFolder,
          messageTs: '',
          resolve: () => undefined,
          settled: false,
        };

        const questionThreadTs = slackThreadTsFromThreadId(request.threadId);
        const questionThreadPayload = questionThreadTs
          ? { thread_ts: questionThreadTs }
          : {};
        const fullBlocks = this.buildUserQuestionBlocks(pendingState);
        const postQuestion = (blocks: unknown[]) =>
          this.app!.client.chat.postMessage({
            channel: parsed.channelId,
            text: promptText,
            ...questionThreadPayload,
            blocks: blocks as any,
          }) as Promise<{ ts?: string }>;
        let sent: { ts?: string };
        try {
          sent = await postQuestion(fullBlocks);
        } catch (blocksErr) {
          logger.warn(
            { requestId: request.requestId, questionIndex: i, err: blocksErr },
            'Slack native user-question blocks rejected; retrying without header',
          );
          sent = await postQuestion(
            fullBlocks.filter(
              (block) => (block as { type?: string }).type !== 'header',
            ),
          );
        }

        const messageTs = sent.ts;
        if (!messageTs) {
          logger.warn(
            { requestId: request.requestId, questionIndex: i },
            'Slack did not return a message timestamp for user question prompt',
          );
          continue;
        }

        const selection = await waitForSlackUserQuestionSelection({
          pendingKey,
          pendingState: { ...pendingState, messageTs },
          pendingUserQuestions: this.pendingUserQuestions,
          timeoutMs,
          finalizeTimedOut: (timedOut) =>
            this.finalizeUserQuestionPrompt(
              timedOut,
              timedOut.question.multiSelect ? [] : '',
              'system',
              'timed out',
            ),
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
    await syncSlackGroups({
      app: this.app,
      force,
      channelNameCache: this.channelNameCache,
      resolveChannelName: (channelId) => this.resolveChannelName(channelId),
      onChatMetadata: this.opts.onChatMetadata,
    });
  }
  isConnected(): boolean {
    return this.app !== null;
  }
  ownsJid(jid: string): boolean {
    return jid.startsWith('sl:');
  }
  async disconnect(): Promise<void> {
    this.app = await disconnectSlackDelivery({
      app: this.app,
      activeStreams: this.activeStreams,
      streamGenerationByJid: this.streamGenerationByJid,
      sealedStreamGenerationByJid: this.sealedStreamGenerationByJid,
      activeProgress: this.activeProgress,
      pendingPermissionPrompts: this.pendingPermissionPrompts,
      pendingUserQuestions: this.pendingUserQuestions,
      stopNativeStream: (channelId, streamTs) =>
        this.tryNativeStreamStop(channelId, streamTs),
    });
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {}
}
