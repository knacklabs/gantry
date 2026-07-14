import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import { getOptionalRuntimeSecret } from '../domain/ports/runtime-secret-provider.js';

interface ProviderRuntimeSecretSettings {
  providerAccounts?: Record<
    string,
    | {
        provider: string;
        runtimeSecretRefs: Record<string, string | undefined>;
      }
    | undefined
  >;
}

export async function getProviderRuntimeSecret(input: {
  providerId: string;
  providerAccountId?: string;
  key: string;
  defaultEnvName?: string;
  settings?: ProviderRuntimeSecretSettings;
  secrets?: RuntimeSecretProvider;
}): Promise<string> {
  if (!input.providerAccountId) return '';
  const account = input.settings?.providerAccounts?.[input.providerAccountId];
  if (!account || account.provider !== input.providerId) return '';
  const ref = account.runtimeSecretRefs[input.key];
  if (!ref) return '';
  return (await getOptionalRuntimeSecret(input.secrets, { ref }))?.trim() || '';
}
