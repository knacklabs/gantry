import * as p from '@clack/prompts';

import { readEnvFile } from './env-file.js';
import { inspectMemoryHealth } from './memory-health.js';
import { envFilePath } from './runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
  type EmbeddingProviderName,
  type MemoryProviderName,
} from './runtime-settings.js';

function usage(): string {
  return [
    'Usage:',
    '  myclaw memory status',
    '  myclaw memory provider <sqlite|qmd|noop|none>',
    '  myclaw memory embeddings <off|disabled|openai>',
    '  myclaw memory dreaming <on|off>',
  ].join('\n');
}

function formatMemoryStatus(runtimeHome: string): string {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  return [
    'MyClaw Memory',
    '',
    `Memory: ${health.memoryEnabled ? 'on' : 'off'} (source: ${health.memorySource})`,
    `Provider: ${health.memoryProvider} (${health.memoryProviderCheck.status}, source: ${health.memoryProviderSource})`,
    `SQLite DB: ${health.sqlitePath} (source: ${health.sqlitePathSource})`,
    `QMD root: ${health.qmdRoot} (source: ${health.qmdRootSource})`,
    `Embeddings: ${health.embeddingsEnabled ? 'on' : 'off'}`,
    `Embedding provider: ${health.embeddingProvider} (${health.embeddingProviderCheck.status}, source: ${health.embeddingProviderSource})`,
    `Embedding model: ${health.embeddingModel} (source: ${health.embeddingModelSource})`,
    `Dreaming: ${health.dreamingEnabled ? 'on' : 'off'} (source: ${health.dreamingSource})`,
  ].join('\n');
}

function setProvider(runtimeHome: string, provider: MemoryProviderName): void {
  const settings = loadRuntimeSettings(runtimeHome);
  settings.memory.provider = provider;
  settings.memory.enabled = provider !== 'noop' && provider !== 'none';
  if (!settings.memory.sqlitePath.trim())
    settings.memory.sqlitePath = 'store/memory.db';
  if (!settings.memory.qmdRoot.trim()) settings.memory.qmdRoot = 'agent-memory';
  saveRuntimeSettings(runtimeHome, settings);
}

function setEmbeddings(
  runtimeHome: string,
  provider: EmbeddingProviderName,
): { ok: boolean; message?: string } {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  if (provider === 'openai' && !env.OPENAI_API_KEY?.trim()) {
    return {
      ok: false,
      message:
        'OPENAI_API_KEY is required only for OpenAI embeddings. Set it with `myclaw config set OPENAI_API_KEY <key>` or run `myclaw memory embeddings off`.',
    };
  }
  settings.memory.embeddings.enabled = provider === 'openai';
  settings.memory.embeddings.provider = provider;
  if (!settings.memory.embeddings.model.trim()) {
    settings.memory.embeddings.model = 'text-embedding-3-large';
  }
  saveRuntimeSettings(runtimeHome, settings);
  return { ok: true };
}

function setDreaming(runtimeHome: string, enabled: boolean): void {
  const settings = loadRuntimeSettings(runtimeHome);
  settings.memory.dreaming.enabled = enabled;
  if (
    enabled &&
    (!settings.memory.enabled ||
      settings.memory.provider === 'noop' ||
      settings.memory.provider === 'none')
  ) {
    settings.memory.enabled = true;
    settings.memory.provider = 'sqlite';
  }
  saveRuntimeSettings(runtimeHome, settings);
}

export async function runMemoryCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, value] = args;

  if (!command || command === 'status') {
    p.note(formatMemoryStatus(runtimeHome), 'Memory');
    return 0;
  }

  if (command === 'provider') {
    if (!['sqlite', 'qmd', 'noop', 'none'].includes(value || '')) {
      p.log.error(usage());
      return 1;
    }
    setProvider(runtimeHome, value as MemoryProviderName);
    p.log.success(`Memory provider set to ${value} in settings.yaml.`);
    return 0;
  }

  if (command === 'embeddings') {
    const normalized = value === 'off' ? 'disabled' : value;
    if (!['disabled', 'openai'].includes(normalized || '')) {
      p.log.error(usage());
      return 1;
    }
    const result = setEmbeddings(
      runtimeHome,
      normalized as EmbeddingProviderName,
    );
    if (!result.ok) {
      p.log.error(result.message || 'Could not update embeddings settings.');
      return 1;
    }
    p.log.success(`Memory embeddings set to ${normalized} in settings.yaml.`);
    return 0;
  }

  if (command === 'dreaming') {
    if (value !== 'on' && value !== 'off') {
      p.log.error(usage());
      return 1;
    }
    setDreaming(runtimeHome, value === 'on');
    p.log.success(`Memory dreaming set to ${value} in settings.yaml.`);
    return 0;
  }

  p.log.error(usage());
  return 1;
}
