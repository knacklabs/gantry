import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import '../channels/register-builtins.js';
import { listChannelProviders } from '../channels/provider-registry.js';

import { readEnvFile } from './env-file.js';
import { DoctorReport, runDoctor } from './doctor.js';
import { getServiceStatus } from './service-manager.js';
import { envFilePath } from './runtime-home.js';
import { ensureRuntimeSettings } from './runtime-settings.js';
import { inspectMemoryHealth } from './memory-health.js';

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
    groups: number;
  }>;
  memoryEnabled: boolean;
  memoryHealth: string;
  memoryRoot: string;
  memoryRootSource: string;
  memorySqlitePath: string;
  memorySqlitePathSource: string;
  embeddingsEnabled: boolean;
  embeddingProvider: string;
  embeddingProviderSource: string;
  embeddingProviderHealth: string;
  embeddingModel: string;
  embeddingModelSource: string;
  dreamingEnabled: boolean;
  dreamingSource: string;
}

function countRegisteredGroupsByPrefix(
  runtimeHome: string,
  jidPrefix: string,
): number {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return 0;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM registered_groups WHERE jid LIKE ?`,
      )
      .get(`${jidPrefix}%`) as {
      count?: number | null;
    };
    return row.count ?? 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

export function collectRuntimeStatus(
  importMetaUrl: string,
  runtimeHome: string,
): RuntimeStatusSummary {
  const env = readEnvFile(envFilePath(runtimeHome));
  const settings = ensureRuntimeSettings(runtimeHome);
  const service = getServiceStatus(runtimeHome);
  const doctor = runDoctor(importMetaUrl, runtimeHome);
  const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
  const embeddingsProviderCheck = doctor.checks.find(
    (check) => check.id === 'embeddings-provider',
  );
  const channels = listChannelProviders().map((provider) => {
    const configuredEnvKeys: string[] = [];
    const missingEnvKeys: string[] = [];
    for (const envKey of provider.setup.envKeys) {
      if (env[envKey]?.trim()) {
        configuredEnvKeys.push(envKey);
      } else {
        missingEnvKeys.push(envKey);
      }
    }

    return {
      id: provider.id,
      label: provider.label,
      enabled: settings.channels[provider.id]?.enabled ?? false,
      configuredEnvKeys,
      missingEnvKeys,
      groups: countRegisteredGroupsByPrefix(runtimeHome, provider.jidPrefix),
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
    memoryRoot: memoryHealth.memoryRoot,
    memoryRootSource: memoryHealth.memoryRootSource,
    memorySqlitePath: memoryHealth.sqlitePath,
    memorySqlitePathSource: memoryHealth.sqlitePathSource,
    embeddingsEnabled: memoryHealth.embeddingsEnabled,
    embeddingProvider: memoryHealth.embeddingProvider,
    embeddingProviderSource: memoryHealth.embeddingProviderSource,
    embeddingProviderHealth: embeddingsProviderCheck?.status || 'unknown',
    embeddingModel: memoryHealth.embeddingModel,
    embeddingModelSource: memoryHealth.embeddingModelSource,
    dreamingEnabled: memoryHealth.dreamingEnabled,
    dreamingSource: memoryHealth.dreamingSource,
  };
}

function statusWord(value: boolean): string {
  return value ? 'on' : 'off';
}

export function formatRuntimeStatus(summary: RuntimeStatusSummary): string {
  const lines: string[] = [];
  lines.push('MyClaw Status');
  lines.push('');
  lines.push(`Runtime home: ${summary.runtimeHome}`);
  lines.push(`Runtime mode: ${summary.runtimeMode}`);
  lines.push(`Doctor: ${summary.doctor.ok ? 'healthy' : 'needs attention'}`);
  lines.push(
    `Doctor warnings: ${summary.doctor.warnings} | Doctor blocking issues: ${summary.doctor.blockingFailures}`,
  );
  for (const channel of summary.channels) {
    const credentials =
      channel.missingEnvKeys.length === 0
        ? channel.configuredEnvKeys.length > 0
          ? 'configured'
          : 'n/a'
        : `missing ${channel.missingEnvKeys.join(', ')}`;
    lines.push(
      `${channel.label}: ${channel.enabled ? 'enabled' : 'disabled'} | credentials: ${credentials} | groups: ${channel.groups}`,
    );
  }
  lines.push(`Memory: ${statusWord(summary.memoryEnabled)}`);
  lines.push(
    `Memory storage: ${summary.memoryHealth} (root: ${summary.memoryRoot}, source: ${summary.memoryRootSource})`,
  );
  lines.push(
    `SQLite memory DB: ${summary.memorySqlitePath} (source: ${summary.memorySqlitePathSource})`,
  );
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
  lines.push(`Service (${summary.service.kind}): ${summary.service.status}`);

  const nextActions: string[] = [];
  const hasReadyChannel = summary.channels.some(
    (channel) =>
      channel.enabled &&
      channel.missingEnvKeys.length === 0 &&
      channel.groups > 0,
  );
  if (!hasReadyChannel) {
    const connectCommands = summary.channels.map(
      (channel) => `myclaw ${channel.id} connect`,
    );
    nextActions.push(
      `Run ${connectCommands.map((cmd) => `\`${cmd}\``).join(' or ')} to finish channel setup.`,
    );
  }
  if (!summary.doctor.ok) {
    nextActions.push('Run `myclaw doctor` and fix blocking items.');
  }
  if (nextActions.length === 0) {
    nextActions.push('Run `myclaw start` to start the runtime.');
  }

  lines.push('');
  lines.push('Next actions:');
  for (const action of nextActions) {
    lines.push(`- ${action}`);
  }

  return lines.join('\n');
}
