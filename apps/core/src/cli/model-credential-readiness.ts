import { ModelCredentialService } from '../application/model-credentials/model-credential-service.js';
import type { AppId } from '../domain/app/app.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  resolveModelSelectionForWorkload,
  type ModelWorkload,
} from '../shared/model-catalog.js';
import type { DoctorCheck } from './doctor.js';

type ModelCredentialReadinessSettings = {
  credentialBroker: { mode: string };
  agent: {
    defaultModel: string;
    oneTimeJobDefaultModel: string;
    recurringJobDefaultModel: string;
  };
  memory: {
    enabled: boolean;
    embeddings: { enabled: boolean; provider: string };
    dreaming: {
      embeddings: { enabled: boolean; provider: string };
    };
    llm: {
      models: {
        extractor: string;
        dreaming: string;
        consolidation: string;
      };
    };
  };
};

type ModelCredentialReadinessStorage = {
  runtimeEventNotifier: { close: () => Promise<void> };
  service: { close: () => Promise<void> };
  repositories: ConstructorParameters<
    typeof ModelCredentialService
  >[0] extends infer Repository
    ? { modelCredentials: Repository }
    : never;
};

export async function inspectModelCredentialReadiness(
  runtimeHome: string,
  settings: ModelCredentialReadinessSettings,
): Promise<DoctorCheck> {
  if (settings.credentialBroker.mode !== 'gantry') {
    return {
      id: 'model-access-credentials',
      title: 'Model Access Credentials',
      status: 'warn',
      message:
        'Model Access is disabled; no provider credentials can be checked.',
      nextAction:
        'Set model_access.enabled to true and add model credentials before running agents.',
    };
  }
  const requiredProviders = requiredModelCredentialProviders(settings);
  if (requiredProviders.length === 0) {
    return {
      id: 'model-access-credentials',
      title: 'Model Access Credentials',
      status: 'pass',
      message: 'No executable model providers are selected.',
    };
  }

  process.env.GANTRY_HOME = runtimeHome;
  let storage: ModelCredentialReadinessStorage | undefined;
  try {
    const { createStorageRuntime } =
      await import('../adapters/storage/postgres/factory.js');
    storage = createStorageRuntime();
    const service = new ModelCredentialService(
      storage.repositories.modelCredentials,
    );
    const rows = await service.list({ appId: 'default' as AppId });
    const healthByProvider = new Map<string, (typeof rows)[number]['health']>(
      rows.map((row) => [row.providerId, row.health]),
    );
    const missing = requiredProviders.filter(
      (providerId) => healthByProvider.get(providerId) !== 'ready',
    );
    if (missing.length > 0) {
      return {
        id: 'model-access-credentials',
        title: 'Model Access Credentials',
        status: 'fail',
        message: `Missing active model credentials for selected defaults: ${missing.join(', ')}.`,
        nextAction: `Run ${missing
          .map((providerId) => `\`gantry credentials model set ${providerId}\``)
          .join(' and ')}.`,
      };
    }
    return {
      id: 'model-access-credentials',
      title: 'Model Access Credentials',
      status: 'pass',
      message: `Active model credentials found for selected defaults: ${requiredProviders.join(', ')}.`,
    };
  } catch (err) {
    return {
      id: 'model-access-credentials',
      title: 'Model Access Credentials',
      status: 'fail',
      message: `Could not inspect model credentials: ${
        err instanceof Error ? err.message : String(err)
      }`,
      nextAction:
        'Confirm Postgres is reachable, migrations have run, and SECRET_ENCRYPTION_KEY is configured.',
    };
  } finally {
    await storage?.runtimeEventNotifier.close().catch(() => undefined);
    await storage?.service.close().catch(() => undefined);
  }
}

function requiredModelCredentialProviders(
  settings: ModelCredentialReadinessSettings,
): string[] {
  const slots: Array<{ alias: string; workload: ModelWorkload }> = [];
  const providers = new Set<string>();
  const chatAlias = settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS;
  slots.push(
    { alias: chatAlias, workload: 'chat' },
    {
      alias: settings.agent.oneTimeJobDefaultModel || chatAlias,
      workload: 'one_time_job',
    },
    {
      alias: settings.agent.recurringJobDefaultModel || chatAlias,
      workload: 'recurring_job',
    },
  );
  if (settings.memory.enabled) {
    const memoryModels = settings.memory.llm.models;
    for (const [alias, workload] of [
      [memoryModels.extractor, 'memory_extractor'],
      [memoryModels.dreaming, 'memory_dreaming'],
      [memoryModels.consolidation, 'memory_consolidation'],
    ] as const) {
      slots.push({ alias, workload });
    }
    const embeddingProviders = [
      settings.memory.embeddings.enabled
        ? settings.memory.embeddings.provider
        : 'disabled',
      settings.memory.dreaming.embeddings.enabled
        ? settings.memory.dreaming.embeddings.provider
        : 'disabled',
    ];
    for (const providerId of embeddingProviders) {
      if (providerId !== 'disabled') providers.add(providerId);
    }
  }
  for (const slot of slots) {
    const resolved = resolveModelSelectionForWorkload(
      slot.alias,
      slot.workload,
    );
    if (resolved.ok) providers.add(resolved.entry.modelRoute.id);
  }
  return [...providers].sort();
}
