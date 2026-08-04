import { ExternalIngressModule } from '../../application/external-ingress/external-ingress-module.js';
import type { ControlRouteContext } from './handler-context.js';
export declare function hasRouteForConversation(routes: Record<string, unknown>, conversationJid: string, threadId?: string | null, providerAccountId?: string | null): boolean;
export declare function resolveConversationMessageRoute(routes: Record<string, unknown>, conversationJid: string, threadId: string | null, providerAccountId?: string | null, agentId?: string | null): {
    agentId?: string | null;
    queueKey: string;
} | null;
export declare function createExternalIngressModule(ctx: ControlRouteContext): ExternalIngressModule;
export declare function invokeExternalIngressForControl(ctx: ControlRouteContext, input: Parameters<ExternalIngressModule['invoke']>[0]): Promise<Awaited<ReturnType<ExternalIngressModule['invoke']>>>;
