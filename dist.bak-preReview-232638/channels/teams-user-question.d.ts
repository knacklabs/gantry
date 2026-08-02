import type { UserQuestionRequest, UserQuestionResponse } from '../domain/types.js';
import type { DurableQuestionCallback } from '../application/interactions/pending-interaction-durability.js';
export interface TeamsUserQuestionSubmit {
    callback: DurableQuestionCallback;
    values: Record<string, string>;
}
export declare function teamsDeliveredQuestionIndexes(request: UserQuestionRequest, firstQuestionIndex: number): number[];
export declare function readTeamsUserQuestionSubmit(value: unknown): TeamsUserQuestionSubmit | null;
export declare function mapTeamsUserQuestionAnswers(request: UserQuestionRequest, values: Record<string, string>): Record<string, string | string[]>;
export declare function formatTeamsUserQuestionReceipt(request: UserQuestionRequest, response: UserQuestionResponse): string;
