import type { GroupDiscoverySource } from '../../domain/types.js';
import { asGroupDiscoverySource } from './channel-capability-ports.js';

export async function syncChannelGroups(
  connectedChannels: readonly {
    channel: Parameters<typeof asGroupDiscoverySource>[0];
  }[],
  force: boolean,
): Promise<void> {
  const syncSources = connectedChannels
    .map((bound) => asGroupDiscoverySource(bound.channel))
    .filter((source): source is GroupDiscoverySource => source !== undefined);
  await Promise.all(syncSources.map((source) => source.syncGroups(force)));
}
