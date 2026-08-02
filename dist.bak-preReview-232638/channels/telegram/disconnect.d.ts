import type { PermissionApprovalRequest, UserQuestionRequest } from '../../domain/types.js';
type InteractionIdentity = Pick<PermissionApprovalRequest, 'appId' | 'sourceAgentFolder' | 'requestId'>;
type PendingTelegramQuestion = {
    timer?: ReturnType<typeof setTimeout>;
    callbackId: string;
    appId: string;
    sourceAgentFolder: string;
    requestId: string;
    multiSelect: boolean;
    optionLabels: string[];
    selectedOptionIndexes: Set<number>;
    resolve(value: {
        selected: string | string[];
        answeredBy: 'system';
    }): void;
};
type TelegramQuestionTarget = Pick<PendingTelegramQuestion, 'appId' | 'sourceAgentFolder' | 'requestId'>;
export declare function disconnectTelegramDelivery(input: {
    bot: {
        stop(): void;
    } | null;
    activeDraftStreams: Map<unknown, {
        closeStream(): void;
    }>;
    activeGroupStreams: Map<unknown, unknown>;
    streamGenerationByJid: Map<unknown, unknown>;
    sealedStreamGenerationByJid: Map<unknown, unknown>;
    activeProgressMessages: Map<unknown, unknown>;
    mediaIngestionQueue: {
        waitForIdle(timeoutMs: number): Promise<boolean>;
    };
    pendingPermissionPrompts: Map<string, {
        timer: ReturnType<typeof setTimeout>;
        request: InteractionIdentity;
        resolve(value: {
            approved: false;
            mode: 'cancel';
            decidedBy: 'system';
            reason: 'Telegram channel disconnected';
        }): void;
    }>;
    settlePermissionPrompt(providerAlias: string): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
    pendingUserQuestionCallbackIds: Map<string, TelegramQuestionTarget>;
    pendingUserQuestions: Map<string, PendingTelegramQuestion>;
    releasePollingLease(): Promise<void>;
}): Promise<{
    bot: null;
    draftStreamApi: null;
}>;
export declare function dropPendingTelegramInteraction(kind: 'permission' | 'question', request: InteractionIdentity | UserQuestionRequest, permissions: Map<string, {
    timer: ReturnType<typeof setTimeout>;
    request: InteractionIdentity;
}>, questions: Map<string, PendingTelegramQuestion>, callbacks: Map<string, TelegramQuestionTarget>, otherPrompts: Map<string, TelegramQuestionTarget>): void;
export {};
