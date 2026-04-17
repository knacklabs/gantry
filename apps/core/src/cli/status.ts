import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

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
  telegramEnabled: boolean;
  telegramTokenConfigured: boolean;
  telegramGroups: number;
  slackEnabled: boolean;
  slackBotTokenConfigured: boolean;
  slackAppTokenConfigured: boolean;
  slackGroups: number;
  memoryEnabled: boolean;
  memoryProvider: string;
  memoryProviderSource: string;
  memoryProviderHealth: string;
  memorySqlitePath: string;
  memorySqlitePathSource: string;
  memoryQmdRoot: string;
  memoryQmdRootSource: string;
  embeddingsEnabled: boolean;
  embeddingProvider: string;
  embeddingProviderSource: string;
  embeddingProviderHealth: string;
  embeddingModel: string;
  embeddingModelSource: string;
  dreamingEnabled: boolean;
  dreamingSource: string;
}

function countRegisteredGroupsByPrefix(runtimeHome: string): {
  telegram: number;
  slack: number;
} {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return { telegram: 0, slack: 0 };

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN jid LIKE 'tg:%' THEN 1 ELSE 0 END) AS telegram_count,
           SUM(CASE WHEN jid LIKE 'sl:%' THEN 1 ELSE 0 END) AS slack_count
         FROM registered_groups`,
      )
      .get() as {
      telegram_count?: number | null;
      slack_count?: number | null;
    };
    return {
      telegram: row.telegram_count ?? 0,
      slack: row.slack_count ?? 0,
    };
  } catch {
    return { telegram: 0, slack: 0 };
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
  const groupCounts = countRegisteredGroupsByPrefix(runtimeHome);
  const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
  const memoryProviderCheck = doctor.checks.find(
    (check) => check.id === 'memory-provider',
  );
  const embeddingsProviderCheck = doctor.checks.find(
    (check) => check.id === 'embeddings-provider',
  );

  return {
    runtimeHome,
    runtimeMode: 'host',
    doctor,
    service,
    telegramEnabled: settings.channels.telegram.enabled,
    telegramTokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN?.trim()),
    telegramGroups: groupCounts.telegram,
    slackEnabled: settings.channels.slack.enabled,
    slackBotTokenConfigured: Boolean(env.SLACK_BOT_TOKEN?.trim()),
    slackAppTokenConfigured: Boolean(env.SLACK_APP_TOKEN?.trim()),
    slackGroups: groupCounts.slack,
    memoryEnabled: memoryHealth.memoryEnabled,
    memoryProvider: memoryHealth.memoryProvider,
    memoryProviderSource: memoryHealth.memoryProviderSource,
    memoryProviderHealth: memoryProviderCheck?.status || 'unknown',
    memorySqlitePath: memoryHealth.sqlitePath,
    memorySqlitePathSource: memoryHealth.sqlitePathSource,
    memoryQmdRoot: memoryHealth.qmdRoot,
    memoryQmdRootSource: memoryHealth.qmdRootSource,
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
  lines.push(
    `Telegram: ${summary.telegramEnabled ? 'enabled' : 'disabled'} | token: ${summary.telegramTokenConfigured ? 'configured' : 'missing'}`,
  );
  lines.push(
    `Slack: ${summary.slackEnabled ? 'enabled' : 'disabled'} | bot token: ${summary.slackBotTokenConfigured ? 'configured' : 'missing'} | app token: ${summary.slackAppTokenConfigured ? 'configured' : 'missing'}`,
  );
  lines.push(`Telegram groups: ${summary.telegramGroups}`);
  lines.push(`Slack groups: ${summary.slackGroups}`);
  lines.push(`Memory: ${statusWord(summary.memoryEnabled)}`);
  lines.push(
    `Memory provider: ${summary.memoryProvider} (${summary.memoryProviderHealth}, source: ${summary.memoryProviderSource})`,
  );
  lines.push(
    `SQLite memory DB: ${summary.memorySqlitePath} (source: ${summary.memorySqlitePathSource})`,
  );
  lines.push(
    `QMD memory root: ${summary.memoryQmdRoot} (source: ${summary.memoryQmdRootSource})`,
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
  if (
    (!summary.telegramEnabled ||
      !summary.telegramTokenConfigured ||
      summary.telegramGroups === 0) &&
    (!summary.slackEnabled ||
      !summary.slackBotTokenConfigured ||
      !summary.slackAppTokenConfigured ||
      summary.slackGroups === 0)
  ) {
    nextActions.push(
      'Run `myclaw telegram connect` or `myclaw slack connect` to finish channel setup.',
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
