import {
  preflightModelProvider,
  type ModelProviderPreflightResult,
  type ModelProviderPreflightSettings,
} from '../adapters/llm/model-provider-preflight.js';
import {
  acquireRuntimeStorage,
  type RuntimeStorageLease,
} from '../adapters/storage/postgres/runtime-store.js';

export type CliModelProviderPreflight = (
  runtimeHome: string,
  providerId: string,
  settings: ModelProviderPreflightSettings,
  chatAlias?: string,
) => Promise<ModelProviderPreflightResult>;

export async function runWithModelCommandPreflight(input: {
  runtimeHome: string;
  preflightProvider?: CliModelProviderPreflight;
  run: (preflightProvider: CliModelProviderPreflight) => Promise<number>;
}): Promise<number> {
  let storageLease: RuntimeStorageLease | undefined;
  let storageLeasePromise: Promise<RuntimeStorageLease> | undefined;
  const preflightProvider =
    input.preflightProvider ??
    (async (runtimeHome, providerId, settings, chatAlias) => {
      if (settings.credentialBroker.mode === 'gantry') {
        storageLeasePromise ??= acquireRuntimeStorage();
        storageLease = await storageLeasePromise;
      }
      return preflightModelProvider({
        runtimeHome,
        providerId,
        chatAlias,
        settings,
        modelCredentials: storageLease?.storage.repositories.modelCredentials,
      });
    });
  try {
    return await input.run(preflightProvider);
  } finally {
    await storageLease?.release();
  }
}
