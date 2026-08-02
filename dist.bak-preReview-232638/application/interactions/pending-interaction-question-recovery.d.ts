import type { QuestionRecoveryEnvelope } from '../../domain/types.js';
export interface DurableQuestionCallback {
    providerAlias: string;
    scope: {
        appId: string;
        sourceAgentFolder: string;
        interactionId: string;
    };
    questionIndex: number;
}
export declare function readQuestionRecoveryEnvelope(value: unknown): QuestionRecoveryEnvelope | null;
