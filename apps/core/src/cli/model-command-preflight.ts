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
  const inFlightPreflights = new Set<Promise<ModelProviderPreflightResult>>();
  const selectedPreflightProvider =
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
  const preflightProvider: CliModelProviderPreflight = (...args) => {
    const preflight = selectedPreflightProvider(...args);
    inFlightPreflights.add(preflight);
    void preflight.then(
      () => inFlightPreflights.delete(preflight),
      () => inFlightPreflights.delete(preflight),
    );
    return preflight;
  };

  const releaseStorageLease = async (): Promise<
    { ok: true } | { ok: false; error: unknown }
  > => {
    await Promise.allSettled([...inFlightPreflights]);
    const lease =
      storageLease ??
      (storageLeasePromise
        ? await storageLeasePromise.then(
            (resolvedLease) => resolvedLease,
            () => undefined,
          )
        : undefined);
    if (!lease) return { ok: true };
    return lease.release().then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
  };

  try {
    const result = await input.run(preflightProvider);
    const cleanup = await releaseStorageLease();
    if (!cleanup.ok) {
      console.error(
        'Model command runtime storage cleanup failed:',
        cleanup.error,
      );
    }
    return result;
  } catch (error) {
    const cleanup = await releaseStorageLease();
    if (!cleanup.ok) {
      throw new AggregateError(
        [error, cleanup.error],
        'Model command failed and runtime storage cleanup also failed',
        { cause: error },
      );
    }
    throw error;
  }
}
