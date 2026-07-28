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
  return input.run(preflightProvider).then(
    async (result) => {
      await storageLease?.release().then(undefined, (cleanupError: unknown) => {
        console.error(
          'Model command runtime storage cleanup failed:',
          cleanupError,
        );
      });
      return result;
    },
    async (error: unknown) => {
      await storageLease?.release().then(undefined, (cleanupError: unknown) => {
        throw new AggregateError(
          [error, cleanupError],
          'Model command failed and runtime storage cleanup also failed',
          { cause: cleanupError },
        );
      });
      throw error;
    },
  );
}
