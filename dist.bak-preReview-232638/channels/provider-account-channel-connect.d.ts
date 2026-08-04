import type { RuntimeLease } from '../domain/ports/runtime-lease.js';
import type { logger } from '../infrastructure/logging/logger.js';
import type { ChannelAdapter, ChannelOpts } from './channel-provider.js';
import { type Provider } from './provider-registry.js';
interface ProviderAccountRuntimeSettings {
    providerAccounts: Record<string, {
        provider: string;
        agentId: string;
        status?: 'active' | 'disabled';
        runtimeSecretRefs?: Record<string, string>;
    }>;
    runtime: {
        deploymentMode?: string;
    };
}
export interface BoundProviderAccountChannel {
    channel: ChannelAdapter;
    providerId: string;
    providerAccountId: string;
    inboundProviderAccountIds: string[];
    interactionCallbacks: boolean;
    agentId: string;
}
export declare function connectProviderAccountChannels(input: {
    provider: Provider;
    appId: string;
    runtimeSettings: ProviderAccountRuntimeSettings;
    channelOpts: ChannelOpts;
    inboundEnabled: boolean;
    connectedChannels: BoundProviderAccountChannel[];
    connectedChannelLeases: RuntimeLease[];
    inboundLeasePrefix: string;
    logger: Pick<typeof logger, 'info' | 'warn'>;
}): Promise<void>;
export {};
