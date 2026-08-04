import { asGroupDiscoverySource } from './channel-capability-ports.js';
export async function syncChannelGroups(connectedChannels, force) {
    const syncSources = connectedChannels
        .map((bound) => asGroupDiscoverySource(bound.channel))
        .filter((source) => source !== undefined);
    await Promise.all(syncSources.map((source) => source.syncGroups(force)));
}
