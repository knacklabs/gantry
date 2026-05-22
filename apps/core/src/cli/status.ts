import '../channels/register-builtins.js';
import { listConnectableChannelProviders } from '../channels/provider-registry.js';

import { readEnvFile } from '../config/env/file.js';
import { DoctorReport, runDoctorWithNetwork } from './doctor.js';
import { getServiceStatus } from '../infrastructure/service/manager.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import { ensureRuntimeSettings } from '../config/settings/runtime-settings.js';
import { inspectMemoryHealth } from './memory-health.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import type { ConversationRoute } from '../domain/types.js';

export interface RuntimeStatusSummary {
  runtimeHome: string;
  runtimeMode: 'host';
  doctor: DoctorReport;
  service: {
    kind: string;
    status: string;
  };
  channels: Array<{
    id: string;
    label: string;
    enabled: boolean;
    configuredEnvKeys: string[];
    missingEnvKeys: string[];
    conversations: number;
    dms: number;
    channels: number;
  }>;
  memoryEnabled: boolean;
  memoryHealth: string;
  storageCapabilityHealth: string;
  storageCapabilityMessage: string;
  storageCapabilityNextAction?: string;
  embeddingsEnabled: boolean;
  embeddingProvider: string;
  embeddingProviderSource: string;
  embeddingProviderHealth: string;
  embeddingModel: string;
  embeddingModelSource: string;
  dreamingEnabled: boolean;
  dreamingSource: string;
  queuePolicy: {
    maxMessageRuns: number;
    maxJobRuns: number;
    maxRetries: number;
    baseRetryMs: number;
  };
}

function countConversationRoutesForProvider(
  routes: Record<string, ConversationRoute>,
  jidPrefix: string,
  isGroupJid: (jid: string) => boolean,
): { conversations: number; dms: number; channels: number } {
  const prefix = jidPrefix.endsWith('%') ? jidPrefix.slice(0, -1) : jidPrefix;
  let dms = 0;
  let channels = 0;
  for (const [jid, route] of Object.entries(routes)) {
    if (!jid.startsWith(prefix)) continue;
    const kind = route.conversationKind ?? (isGroupJid(jid) ? 'channel' : 'dm');
    if (kind === 'dm') dms += 1;
    else channels += 1;
  }
  return { conversations: dms + channels, dms, channels };
}

export async function collectRuntimeStatus(
  importMetaUrl: string,
  runtimeHome: string,
): Promise<RuntimeStatusSummary> {
  const env = readEnvFile(envFilePath(runtimeHome));
  const settings = ensureRuntimeSettings(runtimeHome);
  const service = getServiceStatus(runtimeHome);
  const doctor = await runDoctorWithNetwork(importMetaUrl, runtimeHome, {
    validateTelegramToken: false,
  });
  const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
  const embeddingsProviderCheck = doctor.checks.find(
    (check) => check.id === 'embeddings-provider',
  );
  const storageCapabilityCheck = doctor.checks.find(
    (check) => check.id === 'storage-capabilities',
  );
  let conversationRoutes: Record<string, ConversationRoute> = {};
  let groupDb: Awaited<ReturnType<typeof openRuntimeGroupDb>> | null = null;
  try {
    groupDb = await openRuntimeGroupDb(runtimeHome, { migrate: false });
    conversationRoutes = await groupDb.getAllConversationRoutes();
  } catch {
    conversationRoutes = {};
  } finally {
    if (groupDb) {
      await groupDb.close();
    }
  }

  const channels = listConnectableChannelProviders().map((provider) => {
    const configuredEnvKeys: string[] = [];
    const missingEnvKeys: string[] = [];
    for (const envKey of provider.setup.envKeys) {
      if (env[envKey]?.trim()) {
        configuredEnvKeys.push(envKey);
      } else {
        missingEnvKeys.push(envKey);
      }
    }

    const routeCounts = countConversationRoutesForProvider(
      conversationRoutes,
      provider.jidPrefix,
      provider.isGroupJid,
    );
    return {
      id: provider.id,
      label: provider.label,
      enabled: settings.providers[provider.id]?.enabled ?? false,
      configuredEnvKeys,
      missingEnvKeys,
      ...routeCounts,
    };
  });

  return {
    runtimeHome,
    runtimeMode: 'host',
    doctor,
    service,
    channels,
    memoryEnabled: memoryHealth.memoryEnabled,
    memoryHealth: memoryHealth.memoryCheck.status,
    storageCapabilityHealth: storageCapabilityCheck?.status || 'unknown',
    storageCapabilityMessage:
      storageCapabilityCheck?.message ||
      'Storage capability checks were not available.',
    storageCapabilityNextAction: storageCapabilityCheck?.nextAction,
    embeddingsEnabled: memoryHealth.embeddingsEnabled,
    embeddingProvider: memoryHealth.embeddingProvider,
    embeddingProviderSource: memoryHealth.embeddingProviderSource,
    embeddingProviderHealth: embeddingsProviderCheck?.status || 'unknown',
    embeddingModel: memoryHealth.embeddingModel,
    embeddingModelSource: memoryHealth.embeddingModelSource,
    dreamingEnabled: memoryHealth.dreamingEnabled,
    dreamingSource: memoryHealth.dreamingSource,
    queuePolicy: settings.runtime.queue,
  };
}

function statusWord(value: boolean): string {
  return value ? 'on' : 'off';
}

function isServiceRunning(status: string): boolean {
  return (
    status === 'active' || status === 'running' || status.startsWith('running(')
  );
}

export function formatRuntimeStatus(summary: RuntimeStatusSummary): string {
  const lines: string[] = [];
  lines.push('Gantry Status');
  lines.push('');
  lines.push(`Runtime home: ${summary.runtimeHome}`);
  lines.push(`Runtime mode: ${summary.runtimeMode}`);
  lines.push(`Doctor: ${summary.doctor.ok ? 'healthy' : 'needs attention'}`);
  lines.push(
    `Doctor warnings: ${summary.doctor.warnings} | Doctor blocking issues: ${summary.doctor.blockingFailures}`,
  );
  lines.push(
    `Database: ${summary.storageCapabilityHealth} (${summary.storageCapabilityMessage})`,
  );
  if (summary.storageCapabilityNextAction) {
    lines.push(`Database next action: ${summary.storageCapabilityNextAction}`);
  }
  const readyChannels = summary.channels.filter(
    (channel) =>
      channel.enabled &&
      channel.missingEnvKeys.length === 0 &&
      channel.conversations > 0,
  );
  lines.push(`Channel: ${readyChannels.length > 0 ? 'ready' : 'needs setup'}`);
  const brokerCheck = summary.doctor.checks.find(
    (check) => check.id === 'claude-broker',
  );
  lines.push(`Model Access: ${brokerCheck?.status || 'unknown'}`);
  const brokerPersistenceCheck = summary.doctor.checks.find(
    (check) => check.id === 'onecli-persistence',
  );
  lines.push(
    `Broker persistence: ${brokerPersistenceCheck?.status || 'unknown'}`,
  );
  for (const channel of summary.channels) {
    const credentials =
      channel.missingEnvKeys.length === 0
        ? channel.configuredEnvKeys.length > 0
          ? 'configured'
          : 'n/a'
        : `missing ${channel.missingEnvKeys.join(', ')}`;
    lines.push(
      `${channel.label}: ${channel.enabled ? 'enabled' : 'disabled'} | credentials: ${credentials} | conversations: ${channel.conversations} (DMs: ${channel.dms}, channels/groups: ${channel.channels})`,
    );
  }
  lines.push(`Memory: ${statusWord(summary.memoryEnabled)}`);
  lines.push(`Memory storage: ${summary.memoryHealth} (Postgres app tables)`);
  lines.push(`Embeddings: ${statusWord(summary.embeddingsEnabled)}`);
  lines.push(
    `Embedding provider: ${summary.embeddingProvider} (${summary.embeddingProviderHealth}, source: ${summary.embeddingProviderSource})`,
  );
  lines.push(
    `Embedding model: ${summary.embeddingModel} (source: ${summary.embeddingModelSource})`,
  );
  lines.push(
    `Dreaming: ${statusWord(summary.dreamingEnabled)} (source: ${summary.dreamingSource})`,
  );
  lines.push(
    `Queue: messages=${summary.queuePolicy.maxMessageRuns} jobs=${summary.queuePolicy.maxJobRuns} retries=${summary.queuePolicy.maxRetries} base_retry_ms=${summary.queuePolicy.baseRetryMs}`,
  );
  lines.push(`Service (${summary.service.kind}): ${summary.service.status}`);

  const nextActions: string[] = [];
  const hasReadyChannel = summary.channels.some(
    (channel) =>
      channel.enabled &&
      channel.missingEnvKeys.length === 0 &&
      channel.conversations > 0,
  );
  if (!hasReadyChannel) {
    const connectCommands = summary.channels.map(
      (channel) => `gantry provider connect ${channel.id}`,
    );
    nextActions.push(
      `Run ${connectCommands.map((cmd) => `\`${cmd}\``).join(' or ')} to finish provider/conversation setup.`,
    );
  }
  if (!summary.doctor.ok) {
    nextActions.push('Run `gantry doctor` and fix blocking items.');
  }
  if (nextActions.length === 0 && isServiceRunning(summary.service.status)) {
    nextActions.push('Gantry is running.');
  } else if (nextActions.length === 0) {
    nextActions.push('Run `gantry start` to start the runtime.');
  }

  lines.push('');
  lines.push('Next actions:');
  for (const action of nextActions) {
    lines.push(`- ${action}`);
  }

  return lines.join('\n');
}
