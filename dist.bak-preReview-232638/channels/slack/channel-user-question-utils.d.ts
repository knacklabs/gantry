import { UserQuestionRequest } from '../../domain/types.js';
import type { DurableQuestionCallback } from '../../application/interactions/pending-interaction-durability.js';
export declare function truncateSlackText(text: string, maxLen: number): string;
export declare function truncateSlackButtonText(text: string): string;
export declare function encodeSlackActionValue(value: Record<string, unknown>): string;
export declare function parseSlackUserQuestionActionValue(rawValue: string | undefined): {
    callback: DurableQuestionCallback;
    optionIndex?: number;
} | null;
/** Question + options, without the header (the header gets its own block). */
export declare function formatSlackUserQuestionBody(question: UserQuestionRequest['questions'][number]): string;
export declare function formatSlackUserQuestionPromptText(_request: UserQuestionRequest, question: UserQuestionRequest['questions'][number], _timeoutMs: number): string;
