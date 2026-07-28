import {
  preflightModelProvider,
  type ModelProviderPreflightResult,
} from '../adapters/llm/model-provider-preflight.js';
import {
  acquireRuntimeStorageForRuntimeHome,
  type RuntimeStorageLease,
} from '../adapters/storage/postgres/runtime-store.js';

type RuntimeSettings = Parameters<
  typeof acquireRuntimeStorageForRuntimeHome
>[1];

export type CliModelProviderPreflight = (
  runtimeHome: string,
  providerId: string,
  settings: RuntimeSettings,
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
        storageLeasePromise ??= acquireRuntimeStorageForRuntimeHome(
          runtimeHome,
          settings,
        );
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
