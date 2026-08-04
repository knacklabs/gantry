import type { SessionInteractionModule, SessionQueueIntent } from '../sessions/session-interaction-module.js';
import type { ConversationMessageQueueIntent } from './conversation-message-ingress.js';
export type SessionGroupRegistration = Awaited<ReturnType<SessionInteractionModule['ensureSession']>>['registerGroup'];
export declare const EXTERNAL_INGRESS_RUNTIME_DISPATCH: unique symbol;
export type ExternalIngressRuntimeDispatch = {
    enqueue?: ConversationMessageQueueIntent | SessionQueueIntent;
    localEnqueue?: boolean;
};
export declare function toPublicSessionQueueIntent(enqueue: SessionQueueIntent): {
    conversationJid: string;
    threadId: string | null;
    queueKey: string;
};
