import * as p from '@clack/prompts';
import {
  isEmbeddingProviderRegistered,
  validateEmbeddingProviderReady,
} from '../memory/memory-embeddings.js';

import { readEnvFile } from '../config/env/file.js';
import {
  collectMemoryStatus,
  formatMemoryStatusExtras,
} from './memory-status.js';
import { inspectMemoryHealth } from './memory-health.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import {
  getPresetManagedMemoryDefaults,
  loadRuntimeSettings,
  saveRuntimeSettings,
  type EmbeddingProviderName,
} from '../config/settings/runtime-settings.js';

function usage(): string {
  return [
    'Usage:',
    '  gantry memory status [--json]',
    '  gantry memory embeddings <off|disabled|provider>',
    '  gantry memory dreaming <on|off>',
    '  gantry model memory',
    '  gantry model reset memory',
  ].join('\n');
}

interface EffectiveModelRow {
  model: string;
  source: 'settings.yaml' | 'settings.yaml agent.default_model' | 'default';
}

function resolveEffectiveModel(
  configuredModel: string | undefined,
  globalModel: string | undefined,
  hardDefault: string,
): EffectiveModelRow {
  const configured = configuredModel?.trim();
  if (configured) {
    return { model: configured, source: 'settings.yaml' };
  }
  const global = globalModel?.trim();
  if (global) {
    return { model: global, source: 'settings.yaml agent.default_model' };
  }
  return { model: hardDefault, source: 'default' };
}

function formatMemoryStatus(runtimeHome: string): string {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  const globalModel = settings.agent.defaultModel;
  const hardDefaults = getPresetManagedMemoryDefaults();
  const extractorModel = resolveEffectiveModel(
    settings.memory.llm.models.extractor,
    globalModel,
    hardDefaults.extractor,
  );
  const dreamingModel = resolveEffectiveModel(
    settings.memory.llm.models.dreaming,
    globalModel,
    hardDefaults.dreaming,
  );
  const consolidationModel = resolveEffectiveModel(
    settings.memory.llm.models.consolidation,
    globalModel,
    hardDefaults.consolidation,
  );
  const brokerConfigured =
    settings.credentialBroker.mode === 'onecli'
      ? Boolean(settings.credentialBroker.onecli.url.trim())
      : settings.credentialBroker.mode === 'external'
        ? Boolean(settings.credentialBroker.external.baseUrl.trim())
        : false;
  return [
    'Gantry Memory',
    '',
    `Memory: ${health.memoryEnabled ? 'on' : 'off'} (source: ${health.memorySource})`,
    `Storage: ${health.memoryCheck.status}`,
    `Storage backend: ${health.storageProvider} (source: settings.yaml)`,
    'Memory tables: Postgres runtime schema (app boundaries, evidence, recall, dreaming)',
    `Embeddings: ${health.embeddingsEnabled ? 'on' : 'off'}`,
    `Embedding provider: ${health.embeddingProvider} (${health.embeddingCheck.status}, source: ${health.embeddingProviderSource})`,
    `Embedding model: ${health.embeddingModel} (source: ${health.embeddingModelSource})`,
    `Dreaming: ${health.dreamingEnabled ? 'on' : 'off'} (source: ${health.dreamingSource})`,
    `Model Access: ${brokerConfigured ? 'configured' : 'missing'} (settings.yaml credential_broker)`,
    `Model extractor: ${extractorModel.model} (source: ${extractorModel.source})`,
    `Model dreaming: ${dreamingModel.model} (source: ${dreamingModel.source})`,
    `Model consolidation: ${consolidationModel.model} (source: ${consolidationModel.source})`,
  ].join('\n');
}

async function setEmbeddings(
  runtimeHome: string,
  provider: EmbeddingProviderName,
): Promise<{ ok: boolean; message?: string }> {
  const settings = loadRuntimeSettings(runtimeHome);
  if (provider === 'disabled') {
    settings.memory.embeddings.enabled = false;
  } else if (isEmbeddingProviderRegistered(provider)) {
    try {
      await validateEmbeddingProviderReady(provider);
    } catch (err) {
      return {
        ok: false,
        message: `Embedding provider "${provider}" is not ready: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    settings.memory.embeddings.enabled = true;
  } else {
    return {
      ok: false,
      message: `Unknown embedding provider "${provider}". Register the provider before enabling it, or keep embeddings off.`,
    };
  }
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
  if (enabled && !settings.memory.enabled) settings.memory.enabled = true;
  saveRuntimeSettings(runtimeHome, settings);
}

export async function runMemoryCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, value] = args;

  if (!command || command === 'status') {
    const statusFlags = command ? args.slice(1) : [];
    const jsonMode = statusFlags.includes('--json');
    const snapshot = collectMemoryStatus(runtimeHome);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
      return 0;
    }
    p.note(formatMemoryStatus(runtimeHome), 'Memory');
    p.note(formatMemoryStatusExtras(snapshot), 'Memory Runtime');
    return 0;
  }

  if (command === 'embeddings') {
    const normalized = value === 'off' ? 'disabled' : value;
    if (!normalized || !/^[a-z][a-z0-9_-]{0,62}$/.test(normalized)) {
      p.log.error(usage());
      return 1;
    }
    const result = await setEmbeddings(
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
