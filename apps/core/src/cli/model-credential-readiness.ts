import { ModelCredentialService } from '../application/model-credentials/model-credential-service.js';
import { requiredModelCredentialProviders } from '../application/model-resolution/required-model-credential-providers.js';
import type { AppId } from '../domain/app/app.js';
import type { DoctorCheck } from './doctor.js';
import type { GuidedActionRef } from '../application/guided-actions/guided-action-model.js';

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
      action: {
        type: 'connect_provider',
        label:
          'Set model_access.enabled to true and add model credentials before running agents.',
      },
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
      const missingCredentialAction: GuidedActionRef = {
        type: 'connect_provider',
        label: `Run ${missing
          .map((providerId) => `\`gantry credentials model set ${providerId}\``)
          .join(' and ')}.`,
      };
      return {
        id: 'model-access-credentials',
        title: 'Model Access Credentials',
        status: 'fail',
        message: `Missing active model credentials for selected defaults: ${missing.join(', ')}.`,
        nextAction: missingCredentialAction.label,
        action: missingCredentialAction,
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
      action: {
        type: 'run_verification',
        label:
          'Confirm Postgres is reachable, migrations have run, and SECRET_ENCRYPTION_KEY is configured.',
      },
    };
  } finally {
    await storage?.runtimeEventNotifier.close().catch(() => undefined);
    await storage?.service.close().catch(() => undefined);
  }
}
