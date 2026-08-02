import type { UserQuestionRequest, UserQuestionResponse } from '../domain/types.js';
export declare function buildTeamsQuestionTimeoutAnswers(request: UserQuestionRequest, startIndex: number): {
    remainingQuestionIndexes: number[];
    timeoutAnswers: UserQuestionResponse['answers'];
};
