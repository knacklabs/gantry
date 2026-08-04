import { type StorageRuntimeOptions, type RuntimeOpsRepositories, type StorageRuntime } from './factory.js';
import type { FileArtifactStore } from '../../../domain/ports/file-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type { BrowserProfileArtifactStore, BrowserProfileArtifactMaterializer } from '../../../domain/ports/browser-profile-artifact-store.js';
import type { BrowserProfileSnapshotRepository } from '../../../domain/ports/browser-profile-snapshot.js';
import type { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import type { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import type { RuntimeLease } from '../../../domain/ports/runtime-lease.js';
import type { WorkerCoordinationRepository } from '../../../domain/ports/worker-coordination.js';
/**
 * Discriminates genuine storage-unavailability failures (Postgres down/absent,
 * network unreachable) from real migration/schema/auth/programming errors.
 *
 * Returning true only for connection-level failures keeps the YAML-only and
 * settings-only fallbacks safe: a misconfigured schema or bad credentials will
 * surface as an error instead of being silently masked as "offline".
 */
export declare function isStorageUnavailableError(err: unknown): boolean;
export declare function initializeRuntimeStorage(options?: StorageRuntimeOptions): Promise<StorageRuntime>;
export declare function getRuntimeStorage(): StorageRuntime;
export declare function getRuntimeRepositories(): RuntimeOpsRepositories;
export declare function getRuntimeControlRepository(): PostgresControlPlaneRepository;
export declare function getRuntimeEventExchange(): RuntimeEventExchange;
export declare function getWorkerCoordinationRepository(): WorkerCoordinationRepository;
export declare function getConfiguredModelProvidersForApp(appId: string): Promise<Set<string>>;
export declare function tryAcquireRuntimeAdvisoryLease(key: string): Promise<RuntimeLease | undefined>;
export declare function getRuntimeFileArtifactStore(): FileArtifactStore;
export declare function getRuntimeSkillArtifactStore(): SkillArtifactStore;
export declare function getRuntimeBrowserProfileArtifactStore(): BrowserProfileArtifactStore & BrowserProfileArtifactMaterializer;
export declare function getRuntimeBrowserProfileSnapshotRepository(): BrowserProfileSnapshotRepository;
export declare function closeRuntimeStorage(): Promise<void>;
/** @internal test hook */
export declare function _setRuntimeStorageForTest(nextRuntime: StorageRuntime): void;
