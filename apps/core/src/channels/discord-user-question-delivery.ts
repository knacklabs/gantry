import {
  DurableInteractionPersistenceError,
  recordDurableQuestionAnswerProgress,
  type DurableQuestionCallback,
} from '../application/interactions/pending-interaction-durability.js';
import type {
  MessageDeliveryResult,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import { questionComponents } from './discord-components.js';

const DISCORD_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

export interface PendingDiscordQuestion {
  callbacks: DurableQuestionCallback[];
  request: UserQuestionRequest;
  answers: Record<string, string | string[]>;
  finalizedQuestions: Set<number>;
  resolve: (response: UserQuestionResponse) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export function dropPendingDiscordQuestions(
  pendingQuestions: Map<string, PendingDiscordQuestion>,
  request: Pick<
    UserQuestionRequest,
    'appId' | 'sourceAgentFolder' | 'requestId'
  >,
): void {
  for (const pending of new Set(pendingQuestions.values())) {
    if (
      pending.request.requestId !== request.requestId ||
      pending.request.sourceAgentFolder !== request.sourceAgentFolder ||
      (pending.request.appId || 'default') !== (request.appId || 'default')
    ) {
      continue;
    }
    clearTimeout(pending.timeout);
    for (const callback of pending.callbacks) {
      pendingQuestions.delete(callback.providerAlias);
    }
  }
}

export function resolvePendingDiscordQuestionsOnDisconnect(
  pendingQuestions: Map<string, PendingDiscordQuestion>,
): void {
  for (const pending of new Set(pendingQuestions.values())) {
    clearTimeout(pending.timeout);
    pending.resolve({
      requestId: pending.request.requestId,
      answers: pending.answers,
    });
  }
  pendingQuestions.clear();
}

export async function requestDiscordUserAnswer(input: {
  jid: string;
  request: UserQuestionRequest;
  pendingQuestions: Map<string, PendingDiscordQuestion>;
  sendPrompt: (
    jid: string,
    text: string,
    options: { threadId?: string; components?: unknown[] },
  ) => Promise<MessageDeliveryResult>;
  onPromptDelivered?: (messageId: string, questionIndex?: number) => void;
}): Promise<UserQuestionResponse> {
  const { request } = input;
  if (request.questions.length === 0) {
    return { requestId: request.requestId, answers: {} };
  }
  let resolveResponse!: (response: UserQuestionResponse) => void;
  let rejectResponse!: (reason?: unknown) => void;
  const response = new Promise<UserQuestionResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const callbacks: DurableQuestionCallback[] = [];
  const deliveredQuestionIndexes = new Set<number>();
  const timeout = setTimeout(() => {
    void (async () => {
      const remainingQuestionIndexes = [...deliveredQuestionIndexes].filter(
        (questionIndex) => !pending.finalizedQuestions.has(questionIndex),
      );
      const timeoutAnswers = Object.fromEntries(
        remainingQuestionIndexes.map((questionIndex) => {
          const question = request.questions[questionIndex]!;
          return [
            question.question,
            question.multiSelect ? ([] as string[]) : '',
          ];
        }),
      );
      if (remainingQuestionIndexes.length > 0) {
        const recorded = await recordDurableQuestionAnswerProgress({
          requestId: request.requestId,
          appId: request.appId,
          sourceAgentFolder: request.sourceAgentFolder,
          answers: timeoutAnswers,
          completedQuestionIndexes: remainingQuestionIndexes,
        });
        if (!recorded) {
          throw new DurableInteractionPersistenceError(
            'Discord user question timeout was not persisted',
          );
        }
      }
      for (const callback of callbacks) {
        input.pendingQuestions.delete(callback.providerAlias);
      }
      resolveResponse({
        requestId: request.requestId,
        answers: { ...pending.answers, ...timeoutAnswers },
      });
    })().catch((err) => {
      rejectResponse(
        err instanceof DurableInteractionPersistenceError
          ? err
          : new DurableInteractionPersistenceError(
              'Discord user question timeout could not be persisted',
              err,
            ),
      );
    });
  }, DISCORD_INTERACTION_TIMEOUT_MS);
  timeout.unref?.();
  const pending: PendingDiscordQuestion = {
    callbacks,
    request,
    answers: {},
    finalizedQuestions: new Set<number>(),
    resolve: resolveResponse,
    timeout,
  };
  try {
    for (
      let questionIndex = 0;
      questionIndex < request.questions.length;
      questionIndex += 1
    ) {
      const question = request.questions[questionIndex]!;
      const callback: DurableQuestionCallback = {
        providerAlias: globalThis.crypto.randomUUID(),
        scope: {
          appId: request.appId || 'default',
          sourceAgentFolder: request.sourceAgentFolder,
          interactionId: request.requestId,
        },
        questionIndex,
      };
      callbacks.push(callback);
      input.pendingQuestions.set(callback.providerAlias, pending);
      const text = [
        `Question: ${question.question}`,
        ...question.options.map(
          (option, index) =>
            `${index + 1}. ${option.label}: ${option.description}`,
        ),
      ].join('\n');
      const sent = await input.sendPrompt(input.jid, text, {
        threadId: request.threadId,
        components: questionComponents(
          request,
          questionIndex,
          callback.providerAlias,
        ),
      });
      if (sent.externalMessageId) {
        deliveredQuestionIndexes.add(questionIndex);
        input.onPromptDelivered?.(sent.externalMessageId, questionIndex);
      }
    }
  } catch (err) {
    clearTimeout(timeout);
    for (const callback of callbacks) {
      input.pendingQuestions.delete(callback.providerAlias);
    }
    if (err instanceof DurableInteractionPersistenceError) throw err;
    return { requestId: request.requestId, answers: {} };
  }
  return response;
}
