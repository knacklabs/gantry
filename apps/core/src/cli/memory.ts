import * as p from '@clack/prompts';
import { resolveClaudeAuthState } from '../core/config.js';

import { readEnvFile } from './env-file.js';
import { inspectMemoryHealth } from './memory-health.js';
import { envFilePath } from './runtime-home.js';
import {
  applyMemoryModelProfile,
  getMemoryModelProfileDefaults,
  type MemoryModelProfile,
  type MemoryModelTask,
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
    '  myclaw memory model set <extractor|dreaming|consolidation|sessionSummary> <model>',
    '  myclaw memory model profile <cheap|balanced|quality>',
  ].join('\n');
}

interface EffectiveModelRow {
  model: string;
  source: 'settings.yaml' | 'ANTHROPIC_MODEL' | 'default';
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
    return { model: global, source: 'ANTHROPIC_MODEL' };
  }
  return { model: hardDefault, source: 'default' };
}

function formatMemoryStatus(runtimeHome: string): string {
  const settings = loadRuntimeSettings(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const health = inspectMemoryHealth(runtimeHome, settings, env);
  const globalModel = env.ANTHROPIC_MODEL;
  const hardDefaults = getMemoryModelProfileDefaults('balanced');
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
  const sessionSummaryModel = resolveEffectiveModel(
    settings.memory.llm.models.sessionSummary,
    globalModel,
    hardDefaults.sessionSummary,
  );
  const claudeAuth = resolveClaudeAuthState({
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: env.ANTHROPIC_API_KEY,
  });
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
    `Claude OAuth token: ${claudeAuth.hasOauthToken ? 'present' : 'missing'} (CLAUDE_CODE_OAUTH_TOKEN)`,
    `Claude API key: ${claudeAuth.hasApiKey ? 'present' : 'missing'} (ANTHROPIC_API_KEY)`,
    `Claude auth mode: ${claudeAuth.mode} (precedence: oauth -> api_key)`,
    `Model extractor: ${extractorModel.model} (source: ${extractorModel.source})`,
    `Model dreaming: ${dreamingModel.model} (source: ${dreamingModel.source})`,
    `Model consolidation: ${consolidationModel.model} (source: ${consolidationModel.source})`,
    `Model sessionSummary: ${sessionSummaryModel.model} (source: ${sessionSummaryModel.source})`,
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

function parseModelTask(raw: string | undefined): MemoryModelTask | null {
  if (!raw) return null;
  const normalized = raw.trim();
  if (normalized === 'extractor') return 'extractor';
  if (normalized === 'dreaming') return 'dreaming';
  if (normalized === 'consolidation') return 'consolidation';
  if (
    normalized === 'sessionSummary' ||
    normalized === 'session_summary' ||
    normalized === 'session-summary'
  ) {
    return 'sessionSummary';
  }
  return null;
}

function setTaskModel(
  runtimeHome: string,
  task: MemoryModelTask,
  model: string,
): { ok: boolean; message?: string } {
  const trimmed = model.trim();
  if (!trimmed) {
    return { ok: false, message: 'Model must be a non-empty string.' };
  }
  const settings = loadRuntimeSettings(runtimeHome);
  settings.memory.llm.models[task] = trimmed;
  saveRuntimeSettings(runtimeHome, settings);
  return { ok: true };
}

function setModelProfile(
  runtimeHome: string,
  profile: MemoryModelProfile,
): void {
  const settings = loadRuntimeSettings(runtimeHome);
  applyMemoryModelProfile(settings, profile);
  saveRuntimeSettings(runtimeHome, settings);
}

export async function runMemoryCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, value, extra] = args;

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

  if (command === 'model') {
    if (value === 'set') {
      const task = parseModelTask(args[2]);
      const model = args[3] || '';
      if (!task || !model.trim()) {
        p.log.error(usage());
        return 1;
      }
      const result = setTaskModel(runtimeHome, task, model);
      if (!result.ok) {
        p.log.error(result.message || 'Could not update model setting.');
        return 1;
      }
      p.log.success(
        `Memory model for ${task} set to ${model.trim()} in settings.yaml.`,
      );
      return 0;
    }

    if (value === 'profile') {
      const profile = extra as MemoryModelProfile | undefined;
      if (!profile || !['cheap', 'balanced', 'quality'].includes(profile)) {
        p.log.error(usage());
        return 1;
      }
      setModelProfile(runtimeHome, profile);
      p.log.success(`Memory model profile set to ${profile} in settings.yaml.`);
      return 0;
    }

    p.log.error(usage());
    return 1;
  }

  p.log.error(usage());
  return 1;
}
