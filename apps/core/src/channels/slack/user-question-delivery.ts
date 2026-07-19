import type { App } from '@slack/bolt';

import type {
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { waitForSlackUserQuestionSelection } from './channel-delivery-helpers.js';
import type { PendingUserQuestionState } from './channel-state.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';
import {
  DurableInteractionPersistenceError,
  recordDurableQuestionAnswerProgress,
  type DurableQuestionCallback,
} from '../../application/interactions/pending-interaction-durability.js';

export async function requestSlackUserAnswer(input: {
  app: App;
  channelId: string;
  request: UserQuestionRequest;
  timeoutMs: number;
  pendingUserQuestions: Map<string, PendingUserQuestionState>;
  pendingUserQuestionKey: (callback: DurableQuestionCallback) => string;
  formatPromptText: (
    request: UserQuestionRequest,
    question: UserQuestionRequest['questions'][number],
    timeoutMs: number,
  ) => string;
  buildBlocks: (
    pending: PendingUserQuestionState,
  ) => Array<Record<string, unknown>>;
  finalizeTimedOut: (pending: PendingUserQuestionState) => Promise<void>;
  onPromptDelivered?: (messageId: string, questionIndex?: number) => void;
}): Promise<UserQuestionResponse> {
  const answers: Record<string, string | string[]> = {};
  let answeredBy: string | undefined;

  for (let i = 0; i < input.request.questions.length; i += 1) {
    const question = input.request.questions[i];
    const callback: DurableQuestionCallback = {
      providerAlias: globalThis.crypto.randomUUID(),
      scope: {
        appId: input.request.appId || 'default',
        sourceAgentFolder: input.request.sourceAgentFolder,
        interactionId: input.request.requestId,
      },
      questionIndex: i,
    };
    const pendingKey = input.pendingUserQuestionKey(callback);
    if (input.pendingUserQuestions.has(pendingKey)) {
      logger.warn(
        { requestId: input.request.requestId, questionIndex: i },
        'Duplicate pending Slack user question request detected',
      );
      continue;
    }

    const promptText = input.formatPromptText(
      input.request,
      question,
      input.timeoutMs,
    );

    try {
      const pendingState: PendingUserQuestionState = {
        callback,
        requestId: input.request.requestId,
        questionIndex: i,
        question,
        promptText,
        selectedOptionIndexes: new Set<number>(),
        channelId: input.channelId,
        sourceAgentFolder: input.request.sourceAgentFolder,
        messageTs: '',
        resolve: () => undefined,
        settled: false,
      };

      const questionThreadTs = slackThreadTsFromThreadId(
        input.request.threadId,
      );
      const questionThreadPayload = questionThreadTs
        ? { thread_ts: questionThreadTs }
        : {};
      const fullBlocks = input.buildBlocks(pendingState);
      const postQuestion = (blocks: unknown[]) =>
        input.app.client.chat.postMessage({
          channel: input.channelId,
          text: promptText,
          ...questionThreadPayload,
          blocks: blocks as any,
        }) as Promise<{ ts?: string }>;
      let sent: { ts?: string };
      try {
        sent = await postQuestion(fullBlocks);
      } catch (blocksErr) {
        logger.warn(
          {
            requestId: input.request.requestId,
            questionIndex: i,
            err: blocksErr,
          },
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
          { requestId: input.request.requestId, questionIndex: i },
          'Slack did not return a message timestamp for user question prompt',
        );
        continue;
      }
      input.onPromptDelivered?.(messageTs, i);

      const selection = await waitForSlackUserQuestionSelection({
        pendingKey,
        pendingState: { ...pendingState, messageTs },
        pendingUserQuestions: input.pendingUserQuestions,
        timeoutMs: input.timeoutMs,
        finalizeTimedOut: input.finalizeTimedOut,
      });

      const isEmptySelection = Array.isArray(selection.selected)
        ? selection.selected.length === 0
        : selection.selected.trim().length === 0;
      if (isEmptySelection) {
        const progressRecorded = await recordDurableQuestionAnswerProgress({
          requestId: input.request.requestId,
          appId: input.request.appId,
          sourceAgentFolder: input.request.sourceAgentFolder,
          answers: { [question.question]: selection.selected },
          completedQuestionIndexes: [i],
        });
        if (!progressRecorded) {
          throw new DurableInteractionPersistenceError(
            'Slack user question progress was not persisted',
          );
        }
        continue;
      }

      if (selection.answeredBy) answeredBy = selection.answeredBy;
      answers[question.question] = selection.selected;
      const progressRecorded = await recordDurableQuestionAnswerProgress({
        requestId: input.request.requestId,
        appId: input.request.appId,
        sourceAgentFolder: input.request.sourceAgentFolder,
        answers: { [question.question]: selection.selected },
      });
      if (!progressRecorded) {
        throw new DurableInteractionPersistenceError(
          'Slack user question progress was not persisted',
        );
      }
    } catch (err) {
      if (err instanceof DurableInteractionPersistenceError) throw err;
      logger.warn(
        { requestId: input.request.requestId, questionIndex: i, err },
        'Failed to run Slack user question prompt',
      );
    }
  }

  return {
    requestId: input.request.requestId,
    answers,
    ...(answeredBy ? { answeredBy } : {}),
  };
}
