import type { QuestionRecoveryEnvelope } from '../../domain/types.js';
import { isStringOrNull } from './pending-interaction-permission-envelope.js';

const DEFAULT_APP_ID = 'default';

export interface DurableQuestionCallbackContext {
  appId: string;
  sourceAgentFolder: string;
  requestId: string;
  questionIndex: number;
}

export interface DurableQuestionCallback {
  providerAlias: string;
  scope: {
    appId: string;
    sourceAgentFolder: string;
    interactionId: string;
  };
  questionIndex: number;
}

export function createDurableQuestionCallback(input: {
  appId?: string | null;
  sourceAgentFolder: string;
  requestId: string;
  questionIndex: number;
}): DurableQuestionCallback {
  return {
    providerAlias: globalThis.crypto.randomUUID(),
    scope: {
      appId: input.appId || DEFAULT_APP_ID,
      sourceAgentFolder: input.sourceAgentFolder,
      interactionId: input.requestId,
    },
    questionIndex: input.questionIndex,
  };
}

export function readQuestionRecoveryEnvelope(
  value: unknown,
): QuestionRecoveryEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Partial<QuestionRecoveryEnvelope>;
  if (
    envelope.version !== 1 ||
    !isStringOrNull(envelope.targetJid) ||
    !isStringOrNull(envelope.threadId) ||
    !envelope.request ||
    typeof envelope.request.requestId !== 'string' ||
    typeof envelope.request.sourceAgentFolder !== 'string' ||
    !Array.isArray(envelope.request.questions) ||
    (envelope.nextQuestionIndex !== null &&
      (!Number.isInteger(envelope.nextQuestionIndex) ||
        envelope.nextQuestionIndex! < 0)) ||
    !envelope.callbacks ||
    typeof envelope.callbacks !== 'object' ||
    Array.isArray(envelope.callbacks) ||
    !Array.isArray(envelope.selections) ||
    !envelope.answers ||
    typeof envelope.answers !== 'object' ||
    Array.isArray(envelope.answers) ||
    !Array.isArray(envelope.completedQuestionIndexes) ||
    !envelope.completedQuestionIndexes.every(
      (index) => Number.isInteger(index) && index >= 0,
    ) ||
    !Array.isArray(envelope.deliveredQuestionIndexes) ||
    !envelope.deliveredQuestionIndexes.every(
      (index) => Number.isInteger(index) && index >= 0,
    ) ||
    !envelope.otherPrompts ||
    typeof envelope.otherPrompts !== 'object' ||
    Array.isArray(envelope.otherPrompts)
  ) {
    return null;
  }
  const request = envelope.request;
  const expectedAppId = request.appId || DEFAULT_APP_ID;
  const callbackEntries = [
    ...Object.values(envelope.callbacks),
    ...Object.values(envelope.otherPrompts),
  ];
  if (
    callbackEntries.some((value) => {
      const callback = readQuestionCallbackContext(value);
      return (
        !callback ||
        callback.appId !== expectedAppId ||
        callback.sourceAgentFolder !== request.sourceAgentFolder ||
        callback.requestId !== request.requestId ||
        callback.questionIndex >= request.questions.length
      );
    }) ||
    envelope.completedQuestionIndexes.some(
      (index) => index >= request.questions.length,
    ) ||
    envelope.deliveredQuestionIndexes.some(
      (index) => index >= request.questions.length,
    ) ||
    envelope.selections.some(
      (selection) =>
        !selection ||
        !Number.isInteger(selection.questionIndex) ||
        selection.questionIndex < 0 ||
        selection.questionIndex >= request.questions.length ||
        !Array.isArray(selection.optionIndexes) ||
        selection.optionIndexes.some(
          (index) =>
            !Number.isInteger(index) ||
            index < 0 ||
            index >= request.questions[selection.questionIndex]!.options.length,
        ),
    ) ||
    Object.values(envelope.answers).some(
      (answer) =>
        typeof answer !== 'string' &&
        (!Array.isArray(answer) ||
          answer.some((value) => typeof value !== 'string')),
    )
  ) {
    return null;
  }
  return envelope as QuestionRecoveryEnvelope;
}

export function questionCallbacks(
  value: unknown,
): Record<string, DurableQuestionCallbackContext> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, DurableQuestionCallbackContext] =>
        readQuestionCallbackContext(entry[1]) !== null,
    ),
  );
}

export function questionCallback(
  value: unknown,
  callbackId: string,
): DurableQuestionCallbackContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return readQuestionCallbackContext(
    (value as Record<string, unknown>)[callbackId],
  );
}

function readQuestionCallbackContext(
  value: unknown,
): DurableQuestionCallbackContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const callback = value as Partial<DurableQuestionCallbackContext>;
  return typeof callback.appId === 'string' &&
    typeof callback.sourceAgentFolder === 'string' &&
    typeof callback.requestId === 'string' &&
    Number.isInteger(callback.questionIndex) &&
    callback.questionIndex! >= 0
    ? (callback as DurableQuestionCallbackContext)
    : null;
}
