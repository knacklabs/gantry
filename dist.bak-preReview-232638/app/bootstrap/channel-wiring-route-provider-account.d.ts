import type { RuntimeApp } from './runtime-app.js';
type ProviderAccountBoundChannel = {
    providerId: string;
    providerAccountId: string;
    inboundProviderAccountIds?: string[];
    interactionCallbacks?: boolean;
    channel: {
        ownsJid(jid: string): boolean;
    };
};
export type RouteRequest = {
    threadId?: string | null;
    sourceAgentFolder?: string;
    agentId?: string;
    providerAccountId?: string;
};
export declare function findBoundChannelForProviderAccount<T extends ProviderAccountBoundChannel>(channels: T[], jid: string, providerAccountId?: string): T['channel'] | undefined;
export declare function resolveRouteProviderAccountId(input: {
    app: RuntimeApp;
    jid: string;
} & RouteRequest): string | undefined;
export declare function findBoundChannelForRequest<T extends ProviderAccountBoundChannel>(app: RuntimeApp, channels: T[], jid: string, providerAccountId?: string, request?: RouteRequest): T['channel'] | undefined;
export {};
