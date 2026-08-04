import { type ResolvedStorageConfig } from './storage-service.js';
import { type PostgresDomainRepositoryBundle } from './repositories/domain-repositories.postgres.js';
import { type RuntimeSettings } from '../../../config/index.js';
import type { RuntimeAgentSessionRepository, RuntimeChatMetadataRepository, RuntimeConversationRouteRepository, RuntimeJobRepository, RuntimeMessageRepository, RuntimeRouterStateRepository } from '../../../domain/repositories/ops-repo.js';
import type { FileArtifactStore } from '../../../domain/ports/file-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type { BrowserProfileArtifactStore, BrowserProfileArtifactMaterializer } from '../../../domain/ports/browser-profile-artifact-store.js';
import type { BrowserProfileSnapshotRepository } from '../../../domain/ports/browser-profile-snapshot.js';
import { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import type { PostgresStorageService } from './storage-service.js';
import { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import { PostgresRuntimeEventNotifier } from './runtime-event-notifier.postgres.js';
import type { AgentSession } from '../../../domain/sessions/sessions.js';
import type { LiveAdmissionWakeupSource, LiveTurnCommandWakeupSource } from '../../../domain/ports/live-turns.js';
export type RuntimeOpsRepositories = RuntimeChatMetadataRepository & RuntimeMessageRepository & RuntimeJobRepository & RuntimeRouterStateRepository & RuntimeAgentSessionRepository & RuntimeConversationRouteRepository;
export interface StorageRuntime {
    service: PostgresStorageService;
    ops: RuntimeOpsRepositories;
    control: PostgresControlPlaneRepository;
    repositories: PostgresDomainRepositoryBundle;
    runtimeEvents: RuntimeEventExchange;
    runtimeEventNotifier: PostgresRuntimeEventNotifier;
    liveAdmissionWakeupSource: LiveAdmissionWakeupSource;
    liveTurnCommandWakeupSource: LiveTurnCommandWakeupSource;
    fileArtifacts: FileArtifactStore;
    skillArtifacts: SkillArtifactStore;
    browserProfileSnapshots: BrowserProfileSnapshotRepository;
}
export interface StorageRuntimeOptions {
    storageConfig?: ResolvedStorageConfig;
    runtimeSettings?: RuntimeSettings;
    loadSessionAppMemoryItems?: (input: {
        session: AgentSession;
        limit: number;
        conversationKind?: string;
        query?: string;
    }) => Promise<Array<{
        id: string;
        kind: string;
        key: string;
        value: string;
        subject: Record<string, unknown>;
    }>>;
}
export declare function resolveStorageConfigFromRuntime(): ResolvedStorageConfig;
export declare function createStorageRuntime(config?: ResolvedStorageConfig, options?: StorageRuntimeOptions): StorageRuntime;
export declare function createRuntimeBrowserProfileArtifactStore(): BrowserProfileArtifactStore & BrowserProfileArtifactMaterializer;
