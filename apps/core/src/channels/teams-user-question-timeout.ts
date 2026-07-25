import type {
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';

export function buildTeamsQuestionTimeoutAnswers(
  request: UserQuestionRequest,
  startIndex: number,
): {
  remainingQuestionIndexes: number[];
  timeoutAnswers: UserQuestionResponse['answers'];
} {
  const remainingQuestionIndexes = request.questions.flatMap((_, index) =>
    index >= startIndex ? [index] : [],
  );
  const timeoutAnswers = Object.fromEntries(
    remainingQuestionIndexes.map((questionIndex) => {
      const question = request.questions[questionIndex]!;
      return [question.question, question.multiSelect ? ([] as string[]) : ''];
    }),
  );
  return { remainingQuestionIndexes, timeoutAnswers };
}
