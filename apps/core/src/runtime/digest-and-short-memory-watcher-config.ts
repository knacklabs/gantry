import { getRuntimeSettingsForConfig } from '../config/index.js';
import { agentIdForFolder } from '../config/settings/desired-state-service-helpers.js';

export interface DigestAndShortMemoryWatcherRuntimeConfig {
  conversationIdleAfterMs: number;
  pollIntervalMs: number;
  model: string;
}

export function resolveDigestAndShortMemoryWatcherConfigs(): Map<
  string,
  DigestAndShortMemoryWatcherRuntimeConfig
> {
  const result = new Map<string, DigestAndShortMemoryWatcherRuntimeConfig>();
  let agents: ReturnType<typeof getRuntimeSettingsForConfig>['agents'];
  try {
    agents = getRuntimeSettingsForConfig().agents;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Unreadable settings means no enabled watchers.
  } catch {
    return result;
  }
  for (const [folder, agent] of Object.entries(agents)) {
    const watcher = agent.memory?.digestAndShortMemoryWatcher;
    if (watcher?.enabled) {
      result.set(agentIdForFolder(folder), {
        conversationIdleAfterMs: watcher.conversationIdleAfterMs,
        pollIntervalMs: watcher.pollIntervalMs,
        model: watcher.model,
      });
    }
  }
  return result;
}

export function resolveDigestAndShortMemoryWatcherForFolder(
  folder: string,
): DigestAndShortMemoryWatcherRuntimeConfig | undefined {
  let agents: ReturnType<typeof getRuntimeSettingsForConfig>['agents'];
  try {
    agents = getRuntimeSettingsForConfig().agents;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Unreadable settings means no enabled watcher for this folder.
  } catch {
    return undefined;
  }
  const watcher = agents[folder]?.memory?.digestAndShortMemoryWatcher;
  return watcher
    ? {
        conversationIdleAfterMs: watcher.conversationIdleAfterMs,
        pollIntervalMs: watcher.pollIntervalMs,
        model: watcher.model,
      }
    : undefined;
}
