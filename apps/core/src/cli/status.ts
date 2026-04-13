import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { readEnvFile } from './env-file.js';
import { DoctorReport, runDoctor } from './doctor.js';
import { getServiceStatus } from './service-manager.js';
import { envFilePath } from './runtime-home.js';

export interface RuntimeStatusSummary {
  runtimeHome: string;
  doctor: DoctorReport;
  service: {
    kind: string;
    status: string;
  };
  telegramTokenConfigured: boolean;
  telegramGroups: number;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  return fallback;
}

function countTelegramGroups(runtimeHome: string): number {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM registered_groups WHERE jid LIKE 'tg:%'`,
      )
      .get() as { count: number };
    db.close();
    return row.count;
  } catch {
    return 0;
  }
}

export function collectRuntimeStatus(
  importMetaUrl: string,
  runtimeHome: string,
): RuntimeStatusSummary {
  const env = readEnvFile(envFilePath(runtimeHome));
  const service = getServiceStatus();
  const doctor = runDoctor(importMetaUrl, runtimeHome);
  const memoryProvider = (env.MEMORY_PROVIDER || 'sqlite').trim();
  const embedProvider = (env.MEMORY_EMBED_PROVIDER || 'disabled').trim();

  return {
    runtimeHome,
    doctor,
    service,
    telegramTokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN?.trim()),
    telegramGroups: countTelegramGroups(runtimeHome),
    memoryEnabled: memoryProvider !== 'noop' && memoryProvider !== 'none',
    embeddingsEnabled: embedProvider === 'openai',
    dreamingEnabled: parseBool(env.MEMORY_DREAMING_ENABLED, false),
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
  lines.push(`Doctor: ${summary.doctor.ok ? 'healthy' : 'needs attention'}`);
  lines.push(
    `Doctor warnings: ${summary.doctor.warnings} | Doctor blocking issues: ${summary.doctor.blockingFailures}`,
  );
  lines.push(
    `Telegram token: ${summary.telegramTokenConfigured ? 'configured' : 'missing'}`,
  );
  lines.push(`Telegram groups: ${summary.telegramGroups}`);
  lines.push(`Memory: ${statusWord(summary.memoryEnabled)}`);
  lines.push(`Embeddings: ${statusWord(summary.embeddingsEnabled)}`);
  lines.push(`Dreaming: ${statusWord(summary.dreamingEnabled)}`);
  lines.push(`Service (${summary.service.kind}): ${summary.service.status}`);

  const nextActions: string[] = [];
  if (!summary.telegramTokenConfigured || summary.telegramGroups === 0) {
    nextActions.push('Run `myclaw telegram connect` to finish Telegram setup.');
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
