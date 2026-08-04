import { type RichInteractionRequest, type UserQuestionCancellation, type UserQuestionRequest, type UserQuestionResponse } from '../../domain/types.js';
import type { AgentTodoCardStatus, AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
type ChannelLike = object;
interface ChannelWiringInteractionsLogger {
    debug: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
    error: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
}
interface UserQuestionSurfaceLike {
    requestUserAnswer: (targetJid: string, request: UserQuestionRequest, onPromptDelivered?: (messageId: string, questionIndex?: number) => void) => Promise<UserQuestionResponse>;
    questionIndexesForDeliveredPrompt?: (request: UserQuestionRequest, firstQuestionIndex: number) => number[];
    dropPendingInteraction?: (kind: 'permission' | 'question', request: UserQuestionRequest) => void;
    cancelPendingQuestion?: (cancellation: UserQuestionCancellation) => Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
}
interface AgentTodoSurfaceLike {
    renderAgentTodo: (jid: string, render: AgentTodoRender) => Promise<void | boolean>;
}
interface RichInteractionSurfaceLike {
    renderRichInteraction: (jid: string, request: RichInteractionRequest) => Promise<void | boolean>;
}
type ProviderAccountOptions = {
    providerAccountId?: string;
};
export interface AgentTodoRenderer {
    (jid: string, render: AgentTodoRender, options?: ProviderAccountOptions): Promise<boolean>;
    finalize: (jid: string, input: {
        threadId?: string | null;
        cardKind?: AgentTodoRender['cardKind'];
        status: AgentTodoCardStatus;
    }, options?: ProviderAccountOptions) => Promise<boolean>;
}
export declare function createUserQuestionResponder(input: {
    findBoundChannel: (jid: string, request?: UserQuestionRequest) => ChannelLike | undefined;
    asUserQuestionSurface: (channel: ChannelLike) => UserQuestionSurfaceLike | undefined;
    interactionLifecycle: {
        logger: ChannelWiringInteractionsLogger;
        resetStreaming?: (jid: string, options?: {
            providerAccountId?: string;
            threadId?: string;
        }) => void;
    };
}): {
    requestUserAnswer: (request: UserQuestionRequest) => Promise<UserQuestionResponse>;
    cancelUserQuestion: (cancellation: UserQuestionCancellation) => Promise<'settled' | 'queued' | 'not_found'>;
    clear: () => void;
};
export declare function createRichInteractionRenderer(input: {
    findBoundChannel: (jid: string, providerAccountId?: string) => ChannelLike | undefined;
    asRichInteractionSurface: (channel: ChannelLike) => RichInteractionSurfaceLike | undefined;
    sendMessage: (jid: string, text: string, options?: {
        threadId?: string;
        providerAccountId?: string;
    }) => Promise<unknown>;
    logger: Pick<ChannelWiringInteractionsLogger, 'error'>;
}): (jid: string, request: RichInteractionRequest, options?: ProviderAccountOptions) => Promise<boolean>;
export declare function createAgentTodoRenderer(input: {
    findBoundChannel: (jid: string, providerAccountId?: string) => ChannelLike | undefined;
    asAgentTodoSurface: (channel: ChannelLike) => AgentTodoSurfaceLike | undefined;
    logger: Pick<ChannelWiringInteractionsLogger, 'error'>;
}): AgentTodoRenderer;
export {};
