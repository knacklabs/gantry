import { getProviderRuntimeSecret } from '../channels/provider-runtime-secrets.js';
import { createRepositoryRuntimeSecretProvider } from '../adapters/credentials/repository-runtime-secret-provider.js';
import type { AppId } from '../domain/app/app.js';
import {
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../domain/ports/runtime-secret-provider.js';
import { resolveRuntimeEnvValue } from './runtime-credential-check.js';

type RuntimeSettings = NonNullable<
  Parameters<typeof getProviderRuntimeSecret>[0]['settings']
>;

type RuntimeSecretDoctorStorage = {
  runtimeEventNotifier?: { close: () => Promise<void> };
  service?: { close: () => Promise<void> };
  repositories: {
    capabilitySecrets: Parameters<
      typeof createRepositoryRuntimeSecretProvider
    >[0]['repository'];
  };
};

export async function resolveTelegramTokenForDoctor(input: {
  settings: RuntimeSettings;
  env: Record<string, string>;
}): Promise<{ token: string; unresolvedStoredRef: boolean }> {
  const defaultEnvName = 'TELEGRAM_BOT_TOKEN';
  const accountEntry = Object.entries(
    input.settings.providerAccounts ?? {},
  ).find(([, account]) => account?.provider === 'telegram');
  const providerAccountId = accountEntry?.[0];
  const ref = accountEntry?.[1]?.runtimeSecretRefs.bot_token;
  if (!ref?.trim()) {
    return {
      token: resolveRuntimeEnvValue(input.env, defaultEnvName),
      unresolvedStoredRef: false,
    };
  }

  let parsed: ReturnType<typeof parseRuntimeSecretRefString>;
  try {
    parsed = parseRuntimeSecretRefString(normalizeRuntimeSecretRefString(ref));
  } catch {
    return { token: '', unresolvedStoredRef: true };
  }
  if (parsed.source === 'env') {
    return {
      token: resolveRuntimeEnvValue(input.env, parsed.name),
      unresolvedStoredRef: false,
    };
  }

  let storage: RuntimeSecretDoctorStorage | undefined;
  try {
    const { createStorageRuntime } =
      await import('../adapters/storage/postgres/factory.js');
    storage = createStorageRuntime() as RuntimeSecretDoctorStorage;
    const token = await getProviderRuntimeSecret({
      providerId: 'telegram',
      providerAccountId,
      key: 'bot_token',
      defaultEnvName,
      settings: input.settings,
      secrets: createRepositoryRuntimeSecretProvider({
        appId: 'default' as AppId,
        repository: storage.repositories.capabilitySecrets,
      }),
    });
    return { token, unresolvedStoredRef: !token };
  } catch {
    return { token: '', unresolvedStoredRef: true };
  } finally {
    await storage?.runtimeEventNotifier?.close().catch(() => undefined);
    await storage?.service?.close().catch(() => undefined);
  }
}
