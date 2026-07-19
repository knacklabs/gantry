import type { QuestionRecoveryEnvelope } from '../../domain/types.js';
import { isStringOrNull } from './pending-interaction-permission-envelope.js';

export interface DurableQuestionCallback {
  providerAlias: string;
  scope: {
    appId: string;
    sourceAgentFolder: string;
    interactionId: string;
  };
  questionIndex: number;
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
    !Array.isArray(envelope.selections) ||
    !Array.isArray(envelope.completedQuestionIndexes) ||
    !envelope.completedQuestionIndexes.every(
      (index) => Number.isInteger(index) && index >= 0,
    )
  ) {
    return null;
  }
  const request = envelope.request;
  if (
    envelope.completedQuestionIndexes.some(
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
    )
  ) {
    return null;
  }
  return envelope as QuestionRecoveryEnvelope;
}
