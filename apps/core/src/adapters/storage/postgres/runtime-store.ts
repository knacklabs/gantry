import {
  createStorageRuntime,
  createRuntimeBrowserProfileArtifactStore,
  runtimeStorageScopeKey,
  storageRuntimeOptionsForRuntimeHome,
  type StorageRuntimeOptions,
  type RuntimeOpsRepositories,
  type StorageRuntime,
} from './factory.js';
import type { FileArtifactStore } from '../../../domain/ports/file-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type {
  BrowserProfileArtifactStore,
  BrowserProfileArtifactMaterializer,
} from '../../../domain/ports/browser-profile-artifact-store.js';
import type { BrowserProfileSnapshotRepository } from '../../../domain/ports/browser-profile-snapshot.js';
import { evaluatePostgresStorageCapabilities } from './readiness.js';
import type { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import type { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import type {
  RuntimeLease,
  RuntimeLeaseAcquireOptions,
} from '../../../domain/ports/runtime-lease.js';
import type { WorkerCoordinationRepository } from '../../../domain/ports/worker-coordination.js';
import { configurePendingInteractionDurability } from '../../../application/interactions/pending-interaction-durability.js';
import { ModelCredentialService } from '../../../application/model-credentials/model-credential-service.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  type IdentityResolveInput,
  type IdentityResolveResult,
  PersonIdentityService,
} from '../../../application/identity/person-identity-service.js';
import { PostgresPersonIdentityRepository } from './repositories/person-identity-repository.postgres.js';
import type { RuntimeEventPublishInput } from '../../../domain/events/events.js';

let runtime: StorageRuntime | null = null;
let runtimeScopeKey: string | undefined;
let commandOwnedRuntime:
  | {
      storage: StorageRuntime;
      scopeKey: string;
      activeLeases: number;
      closed: boolean;
      released: Promise<void>;
      resolveReleased: () => void;
      rejectReleased: (error: unknown) => void;
      closePromise?: Promise<void>;
    }
  | undefined;
let commandRuntimeInitialization:
  | { scopeKey: string; promise: Promise<StorageRuntime> }
  | undefined;

export interface RuntimeStorageLease {
  storage: StorageRuntime;
  owned: boolean;
  release: () => Promise<void>;
}

async function closeStorageRuntimeResources(
  storage: StorageRuntime,
): Promise<void> {
  const failures: unknown[] = [];
  for (const close of [
    () => storage.liveTurnCommandWakeupSource.close(),
    () => storage.liveAdmissionWakeupSource.close(),
    () => storage.runtimeEventNotifier.close(),
    () => storage.service.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Failed to close runtime storage');
  }
}

/**
 * Discriminates genuine storage-unavailability failures (Postgres down/absent,
 * network unreachable) from real migration/schema/auth/programming errors.
 *
 * Returning true only for connection-level failures keeps the YAML-only and
 * settings-only fallbacks safe: a misconfigured schema or bad credentials will
 * surface as an error instead of being silently masked as "offline".
 */
export function isStorageUnavailableError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === '3D000' ||
    code === '57P03' ||
    code === '08001' ||
    code === '08006'
  ) {
    return true;
  }
  const message = (err as { message?: string }).message;
  if (typeof message === 'string') {
    return /econnrefused|connection refused|connection terminated|could not connect|getaddrinfo|connect etimedout|database "[^"]*" does not exist/.test(
      message.toLowerCase(),
    );
  }
  return false;
}

export async function initializeRuntimeStorage(
  options: StorageRuntimeOptions = {},
): Promise<StorageRuntime> {
  const nextScopeKey = runtimeStorageScopeKey(options);
  const nextRuntime = createStorageRuntime(undefined, options);
  try {
    await nextRuntime.service.assertMigrationsCurrent();
    const capabilities = await nextRuntime.service.healthCheck();
    const failure = evaluatePostgresStorageCapabilities(capabilities);
    if (failure) {
      throw new Error([failure.summary, ...failure.details].join('\n'));
    }
    runtime = nextRuntime;
    runtimeScopeKey = nextScopeKey;
    configurePendingInteractionDurability({
      repository: nextRuntime.repositories.workerCoordination,
      liveTurns: nextRuntime.repositories.liveTurns,
      warn: (context, message) => logger.warn(context, message),
    });
    return nextRuntime;
  } catch (err) {
    try {
      await closeStorageRuntimeResources(nextRuntime);
    } catch (closeError) {
      logger.warn(
        { err: closeError },
        'Runtime storage cleanup failed after initialization error',
      );
    }
    throw err;
  }
}

/**
 * Acquires the process runtime storage without taking ownership from a caller
 * that already initialized it. Command-scoped callers must release the lease;
 * only a storage runtime created by this acquisition will be closed.
 */
export async function acquireRuntimeStorage(
  options: StorageRuntimeOptions = {},
): Promise<RuntimeStorageLease> {
  if (
    runtime &&
    (!commandOwnedRuntime || runtime !== commandOwnedRuntime.storage)
  ) {
    return {
      storage: runtime,
      owned: false,
      release: async () => undefined,
    };
  }
  return acquireRuntimeStorageForScope(
    runtimeStorageScopeKey(options),
    options,
  );
}

export async function acquireRuntimeStorageForRuntimeHome(
  runtimeHome: string,
  runtimeSettings: Parameters<typeof storageRuntimeOptionsForRuntimeHome>[1],
): Promise<RuntimeStorageLease> {
  const options = storageRuntimeOptionsForRuntimeHome(
    runtimeHome,
    runtimeSettings,
  );
  const scopeKey = runtimeStorageScopeKey(options);
  return acquireRuntimeStorageForScope(scopeKey, options);
}

async function acquireRuntimeStorageForScope(
  scopeKey: string,
  options: StorageRuntimeOptions,
): Promise<RuntimeStorageLease> {
  while (true) {
    const ownedRuntime = commandOwnedRuntime;
    if (ownedRuntime && runtime === ownedRuntime.storage) {
      if (ownedRuntime.scopeKey === scopeKey) {
        ownedRuntime.activeLeases += 1;
        return commandRuntimeLease(ownedRuntime);
      }
      await ownedRuntime.released;
      continue;
    }
    if (ownedRuntime?.closed && runtime === null) {
      await ownedRuntime.closePromise;
      continue;
    }
    if (runtime) {
      if (runtimeScopeKey !== scopeKey) {
        throw new Error(
          'Runtime storage is already initialized for a different runtime home',
        );
      }
      return {
        storage: runtime,
        owned: false,
        release: async () => undefined,
      };
    }
    const initialization = commandRuntimeInitialization;
    if (initialization) {
      if (initialization.scopeKey === scopeKey) {
        await initialization.promise;
        continue;
      }
      try {
        await initialization.promise;
      } catch {
        // The caller that started initialization receives the original error.
      }
      continue;
    }
    let resolveReleased: () => void = () => undefined;
    let rejectReleased: (error: unknown) => void = () => undefined;
    const released = new Promise<void>((resolve, reject) => {
      resolveReleased = resolve;
      rejectReleased = reject;
    });
    void released.catch(() => undefined);
    const promise = (async () => {
      const storage = await initializeRuntimeStorage(options);
      commandOwnedRuntime = {
        storage,
        scopeKey,
        activeLeases: 0,
        closed: false,
        released,
        resolveReleased,
        rejectReleased,
      };
      return storage;
    })();
    commandRuntimeInitialization = { scopeKey, promise };
    try {
      await promise;
    } finally {
      if (commandRuntimeInitialization?.promise === promise) {
        commandRuntimeInitialization = undefined;
      }
    }
  }
}

function commandRuntimeLease(
  owner: NonNullable<typeof commandOwnedRuntime>,
): RuntimeStorageLease {
  let released = false;
  return {
    storage: owner.storage,
    owned: true,
    release: async () => {
      if (released) return;
      released = true;
      owner.activeLeases -= 1;
      if (owner.activeLeases > 0) return;
      await closeCommandOwnedRuntime(owner);
    },
  };
}

function closeCommandOwnedRuntime(
  owner: NonNullable<typeof commandOwnedRuntime>,
): Promise<void> {
  if (owner.closePromise) return owner.closePromise;
  owner.closed = true;
  if (runtime === owner.storage) {
    runtime = null;
    runtimeScopeKey = undefined;
    configurePendingInteractionDurability(null);
  }
  const closePromise = (async () => {
    try {
      await closeStorageRuntimeResources(owner.storage);
      owner.resolveReleased();
    } catch (error) {
      owner.rejectReleased(error);
      throw error;
    } finally {
      if (commandOwnedRuntime === owner) commandOwnedRuntime = undefined;
    }
  })();
  owner.closePromise = closePromise;
  return closePromise;
}

export function getRuntimeStorage(): StorageRuntime {
  if (!runtime) {
    throw new Error('Runtime storage has not been initialized');
  }
  return runtime;
}

export function getRuntimeRepositories(): RuntimeOpsRepositories {
  return getRuntimeStorage().ops;
}

export function getRuntimeControlRepository(): PostgresControlPlaneRepository {
  return getRuntimeStorage().control;
}

export function getRuntimeEventExchange(): RuntimeEventExchange {
  return getRuntimeStorage().runtimeEvents;
}

export function getWorkerCoordinationRepository(): WorkerCoordinationRepository {
  return getRuntimeStorage().repositories.workerCoordination;
}

// Provider ids (route ids) with an ACTIVE configured Model Access credential for
// an app. Source for credential-driven model-family provider selection at the
// runtime spawn/job seams; resolved here so runtime callers do not reach into
// the adapter layer themselves.
export async function getConfiguredModelProvidersForApp(
  appId: string,
): Promise<Set<string>> {
  return new ModelCredentialService(
    getRuntimeStorage().repositories.modelCredentials,
  ).getConfiguredModelProviders({ appId: appId as never });
}

export async function resolveRuntimePersonIdentity(
  input: IdentityResolveInput,
  auditEventFactory?: (
    result: IdentityResolveResult,
  ) => RuntimeEventPublishInput,
): Promise<IdentityResolveResult> {
  return new PersonIdentityService(
    new PostgresPersonIdentityRepository(getRuntimeStorage().service.db),
  ).resolve(input, auditEventFactory);
}

export async function tryAcquireRuntimeAdvisoryLease(
  key: string,
  options: RuntimeLeaseAcquireOptions = {},
): Promise<RuntimeLease | undefined> {
  const client = await getRuntimeStorage().service.pool.connect();
  let released = false;
  let lostError: Error | undefined;
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    if (!result.rows[0]?.acquired) {
      client.release();
      released = true;
      return undefined;
    }
    // Bump the durable generation on THIS connection, which already holds the
    // advisory lock — that is what serializes the bump against other holders of
    // the same key. A separate pooled connection would not be serialized.
    //
    // Fails closed: if this throws, the catch below releases the connection
    // (dropping the advisory lock with it) and no lease is returned. An
    // unfenced lease is worse than no lease.
    // SHARED reads the current generation; OWNERSHIP advances it. Both hold the
    // same advisory lock, so exclusion is identical — only the epoch differs.
    const generationResult = await client.query<{
      generation: string | number;
    }>(
      options.shared
        ? `SELECT COALESCE(
             (SELECT generation FROM runtime_lease_generations WHERE lease_key = $1),
             0
           ) AS generation, $2::text AS holder`
        : `INSERT INTO runtime_lease_generations (lease_key, generation, holder, updated_at)
       VALUES ($1, 1, $2, now())
       ON CONFLICT (lease_key) DO UPDATE
         SET generation = runtime_lease_generations.generation + 1,
             holder = EXCLUDED.holder,
             updated_at = now()
       RETURNING generation`,
      // ponytail: diagnostic only, so keep it dependency-free rather than
      // importing the worker identity from jobs/ (no adapter does today).
      [key, `pid-${process.pid}`],
    );
    // node-postgres returns bigint as a string to avoid precision loss.
    const rawGeneration = generationResult.rows[0]?.generation;
    const generation = Number(rawGeneration);
    // A shared acquisition may legitimately report 0 (nobody has ever owned this
    // key); an ownership acquisition must always yield at least 1.
    const minimumGeneration = options.shared ? 0 : 1;
    if (!Number.isSafeInteger(generation) || generation < minimumGeneration) {
      throw new Error(
        `Runtime advisory lease generation bump returned no usable generation for ${key}: ${String(rawGeneration)}`,
      );
    }
    const lostHandlers = new Set<(err: Error) => void>();
    const notifyLost = (err: Error) => {
      if (released) return;
      lostError = err;
      released = true;
      for (const handler of [...lostHandlers]) handler(err);
      client.removeListener('error', notifyLost);
      client.removeListener('end', notifyEnd);
      try {
        client.release(err);
      } catch {
        // Best effort release after the lease connection is already broken.
      }
    };
    const notifyEnd = () => {
      notifyLost(new Error(`Runtime advisory lease connection ended: ${key}`));
    };
    client.once('error', notifyLost);
    client.once('end', notifyEnd);
    return {
      generation,
      isValid: () => !lostError && !released,
      onLost: (handler) => {
        if (lostError) handler(lostError);
        else lostHandlers.add(handler);
      },
      release: async () => {
        if (released) return;
        released = true;
        client.removeListener('error', notifyLost);
        client.removeListener('end', notifyEnd);
        try {
          await client.query(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
            [key],
          );
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    if (!released) {
      // ALWAYS destroy here. pg advisory locks are session-scoped, and a
      // no-argument release() returns the session to the pool with any lock
      // still held — wedging the key for every other session, while a later
      // acquisition on that same session re-enters the lock and would need
      // more unlocks than anyone will issue.
      //
      // Every path into this catch has an unknown-or-held lock state: the lock
      // query may have executed server-side before a cancellation or a
      // result-delivery failure, so "the query threw" does NOT mean "no lock
      // was taken". Passing an error is what actually destroys the connection.
      // The clean refused case (`acquired: false`) returns above and keeps its
      // plain release, because there the server told us definitively.
      client.release(err instanceof Error ? err : new Error(String(err)));
      released = true;
    }
    throw err;
  }
}

export function getRuntimeFileArtifactStore(): FileArtifactStore {
  return getRuntimeStorage().fileArtifacts;
}

export function getRuntimeSkillArtifactStore(): SkillArtifactStore {
  return getRuntimeStorage().skillArtifacts;
}

export function getRuntimeBrowserProfileArtifactStore(): BrowserProfileArtifactStore &
  BrowserProfileArtifactMaterializer {
  getRuntimeStorage();
  return createRuntimeBrowserProfileArtifactStore();
}

export function getRuntimeBrowserProfileSnapshotRepository(): BrowserProfileSnapshotRepository {
  return getRuntimeStorage().browserProfileSnapshots;
}

export async function closeRuntimeStorage(): Promise<void> {
  const existing = runtime;
  const ownedRuntime =
    commandOwnedRuntime?.storage === existing ||
    (existing === null && commandOwnedRuntime?.closed)
      ? commandOwnedRuntime
      : undefined;
  if (ownedRuntime) {
    await closeCommandOwnedRuntime(ownedRuntime);
    return;
  }
  runtime = null;
  runtimeScopeKey = undefined;
  configurePendingInteractionDurability(null);
  if (existing) await closeStorageRuntimeResources(existing);
}

/**
 * @internal test hook
 *
 * Pass `scope` to install the storage AS the storage for a specific runtime
 * home, so a home-scoped caller (a CLI command) reuses it instead of opening a
 * second runtime against a schema it has not migrated. Without `scope` the
 * scope stays unknown and any explicit home is rejected — the invariant
 * asserted by 'rejects an explicit runtime home when service-owned storage
 * scope is unknown'.
 */
export function _setRuntimeStorageForTest(
  nextRuntime: StorageRuntime,
  scope?: StorageRuntimeOptions,
): void {
  runtime = nextRuntime;
  runtimeScopeKey = scope ? runtimeStorageScopeKey(scope) : 'process-runtime';
  const workerCoordination = nextRuntime.repositories?.workerCoordination;
  configurePendingInteractionDurability(
    workerCoordination
      ? {
          repository: workerCoordination,
          liveTurns: nextRuntime.repositories?.liveTurns ?? null,
        }
      : null,
  );
}
