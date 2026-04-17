import fs from 'fs';
import path from 'path';

import { MemoryStore } from '../memory/memory-store.js';
import { OpenAIEmbeddingClient } from '../memory/memory-embeddings.js';
import type { RuntimeSettings } from './runtime-settings.js';

export type HealthStatus = 'pass' | 'warn' | 'fail';
export type ConfigSource = 'settings.yaml' | 'default';

export interface HealthCheckResult {
  status: HealthStatus;
  message: string;
  nextAction?: string;
}

interface HealthContext {
  runtimeHome: string;
  env: Record<string, string | undefined>;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  sqlitePath: string;
  qmdRoot: string;
  embeddingModel: string;
}

type MemoryProviderInspector = (ctx: HealthContext) => HealthCheckResult;
type EmbeddingProviderInspector = (ctx: HealthContext) => HealthCheckResult;

const memoryProviderInspectors = new Map<string, MemoryProviderInspector>();
const embeddingProviderInspectors = new Map<
  string,
  EmbeddingProviderInspector
>();

export function resolveRuntimePath(
  runtimeHome: string,
  rawValue: string | undefined,
  fallbackRelativePath: string,
): string {
  const raw = rawValue?.trim();
  if (!raw) return path.resolve(runtimeHome, fallbackRelativePath);
  return path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(runtimeHome, raw);
}

function withMemoryStoreHealthCheck(sqlitePath: string): void {
  let store: MemoryStore | null = null;
  try {
    store = new MemoryStore(sqlitePath);
    store.runHealthChecks();
  } finally {
    try {
      store?.close();
    } catch {
      // best-effort close in health checks
    }
  }
}

export function registerMemoryProviderInspector(
  name: string,
  inspector: MemoryProviderInspector,
): void {
  memoryProviderInspectors.set(name, inspector);
}

export function registerEmbeddingProviderInspector(
  name: string,
  inspector: EmbeddingProviderInspector,
): void {
  embeddingProviderInspectors.set(name, inspector);
}

function inspectMemoryProvider(
  providerName: string,
  ctx: HealthContext,
): HealthCheckResult {
  if (!ctx.memoryEnabled) {
    return {
      status: 'pass',
      message: 'Memory is disabled in settings.yaml.',
    };
  }

  const inspector = memoryProviderInspectors.get(providerName);
  if (!inspector) {
    return {
      status: 'fail',
      message: `Unknown memory provider "${providerName}".`,
      nextAction:
        'Set memory.provider in settings.yaml to sqlite, qmd, noop, or none.',
    };
  }
  return inspector(ctx);
}

function inspectEmbeddings(
  providerName: string,
  ctx: HealthContext,
): HealthCheckResult {
  if (!ctx.memoryEnabled) {
    return {
      status: 'pass',
      message: 'Memory is disabled, so embeddings are not required.',
    };
  }

  if (!ctx.embeddingsEnabled) {
    return {
      status: 'pass',
      message:
        'Embeddings are optional and currently disabled in settings.yaml.',
    };
  }

  const inspector = embeddingProviderInspectors.get(providerName);
  if (!inspector) {
    return {
      status: 'fail',
      message: `Unknown embedding provider "${providerName}".`,
      nextAction:
        'Set memory.embeddings.provider in settings.yaml to openai, disabled, or none.',
    };
  }
  return inspector(ctx);
}

export interface MemoryHealthInspection {
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  memoryProvider: string;
  embeddingProvider: string;
  sqlitePath: string;
  qmdRoot: string;
  embeddingModel: string;
  memorySource: ConfigSource;
  memoryProviderSource: ConfigSource;
  sqlitePathSource: ConfigSource;
  qmdRootSource: ConfigSource;
  embeddingProviderSource: ConfigSource;
  embeddingModelSource: ConfigSource;
  dreamingSource: ConfigSource;
  memoryProviderCheck: HealthCheckResult;
  embeddingProviderCheck: HealthCheckResult;
  warnings: HealthCheckResult[];
}

export function inspectMemoryHealth(
  runtimeHome: string,
  settings: RuntimeSettings | undefined,
  env: Record<string, string | undefined>,
): MemoryHealthInspection {
  const warnings: HealthCheckResult[] = [];
  const settingsMemory = settings?.memory;

  const memoryEnabled = settingsMemory?.enabled ?? true;
  const embeddingsEnabled = settingsMemory?.embeddings.enabled ?? false;
  const dreamingEnabled = settingsMemory?.dreaming.enabled ?? false;
  const memoryProvider = settingsMemory
    ? settingsMemory.enabled
      ? settingsMemory.provider
      : settingsMemory.provider || 'noop'
    : 'sqlite';
  const embeddingProvider = settingsMemory
    ? settingsMemory.embeddings.enabled
      ? settingsMemory.embeddings.provider
      : 'disabled'
    : 'disabled';
  const sqliteRaw = settingsMemory?.sqlitePath;
  const qmdRaw = settingsMemory?.qmdRoot;
  const embeddingModel =
    settingsMemory?.embeddings.model || 'text-embedding-3-large';
  const sqlitePath = resolveRuntimePath(
    runtimeHome,
    sqliteRaw,
    path.join('store', 'memory.db'),
  );
  const qmdRoot = resolveRuntimePath(runtimeHome, qmdRaw, 'agent-memory');

  const context: HealthContext = {
    runtimeHome,
    env,
    memoryEnabled,
    embeddingsEnabled,
    sqlitePath,
    qmdRoot,
    embeddingModel,
  };

  return {
    memoryEnabled,
    embeddingsEnabled,
    dreamingEnabled,
    memoryProvider,
    embeddingProvider,
    sqlitePath,
    qmdRoot,
    embeddingModel,
    memorySource: settingsMemory ? 'settings.yaml' : 'default',
    memoryProviderSource: settingsMemory ? 'settings.yaml' : 'default',
    sqlitePathSource: settingsMemory?.sqlitePath ? 'settings.yaml' : 'default',
    qmdRootSource: settingsMemory?.qmdRoot ? 'settings.yaml' : 'default',
    embeddingProviderSource: settingsMemory ? 'settings.yaml' : 'default',
    embeddingModelSource: settingsMemory?.embeddings.model
      ? 'settings.yaml'
      : 'default',
    dreamingSource: settingsMemory ? 'settings.yaml' : 'default',
    memoryProviderCheck: inspectMemoryProvider(memoryProvider, context),
    embeddingProviderCheck: inspectEmbeddings(embeddingProvider, context),
    warnings,
  };
}

registerMemoryProviderInspector('sqlite', (ctx) => {
  try {
    withMemoryStoreHealthCheck(ctx.sqlitePath);
    return {
      status: 'pass',
      message: `SQLite memory store is healthy (${ctx.sqlitePath}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      message: `SQLite memory store health check failed at ${ctx.sqlitePath}.`,
      nextAction: `Repair memory.sqlite_path or provider configuration. Details: ${message}`,
    };
  }
});

registerMemoryProviderInspector('qmd', (ctx) => {
  const sqlitePath = path.join(ctx.qmdRoot, '.cache', 'memory.db');
  try {
    fs.mkdirSync(path.join(ctx.qmdRoot, '.cache'), { recursive: true });
    fs.accessSync(ctx.qmdRoot, fs.constants.W_OK);
    withMemoryStoreHealthCheck(sqlitePath);
    return {
      status: 'pass',
      message: `QMD memory store is healthy (${sqlitePath}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      message: `QMD memory provider health check failed at ${ctx.qmdRoot}.`,
      nextAction: `Ensure memory.qmd_root is writable and sqlite-vec can initialize. Details: ${message}`,
    };
  }
});

const noopInspector: MemoryProviderInspector = (ctx) => {
  if (ctx.memoryEnabled) {
    return {
      status: 'warn',
      message:
        'Memory is enabled, but current provider is non-persistent (noop).',
      nextAction: 'Set memory.provider to sqlite or qmd for durable memory.',
    };
  }
  return {
    status: 'pass',
    message:
      'Non-persistent memory provider is expected because memory is disabled.',
  };
};

registerMemoryProviderInspector('noop', noopInspector);
registerMemoryProviderInspector('none', noopInspector);

registerEmbeddingProviderInspector('openai', (ctx) => {
  const apiKey = ctx.env.OPENAI_API_KEY?.trim() || '';
  if (!apiKey) {
    return {
      status: 'warn',
      message:
        'Embeddings are enabled with provider openai, but OPENAI_API_KEY is missing.',
      nextAction:
        'Set OPENAI_API_KEY in .env or run `myclaw memory embeddings off`. Memory still works without embeddings.',
    };
  }

  try {
    const client = new OpenAIEmbeddingClient(apiKey, ctx.embeddingModel);
    client.validateConfiguration();
    return {
      status: 'pass',
      message: `Embedding provider is ready (openai, model: ${ctx.embeddingModel}).`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      message: 'Embedding provider configuration is invalid.',
      nextAction: `Fix memory.embeddings.model/provider config. Details: ${message}`,
    };
  }
});

const disabledEmbeddingInspector: EmbeddingProviderInspector = (ctx) => ({
  status: ctx.embeddingsEnabled ? 'warn' : 'pass',
  message: ctx.embeddingsEnabled
    ? 'Embeddings are enabled, but embedding provider is disabled.'
    : 'Embeddings are optional and currently disabled.',
  ...(ctx.embeddingsEnabled
    ? {
        nextAction:
          'Set memory.embeddings.provider to openai or disable embeddings.',
      }
    : {}),
});

registerEmbeddingProviderInspector('disabled', disabledEmbeddingInspector);
registerEmbeddingProviderInspector('none', disabledEmbeddingInspector);
