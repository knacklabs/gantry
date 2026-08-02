import { asGroupDiscoverySource } from './channel-capability-ports.js';
export declare function syncChannelGroups(connectedChannels: readonly {
    channel: Parameters<typeof asGroupDiscoverySource>[0];
}[], force: boolean): Promise<void>;
