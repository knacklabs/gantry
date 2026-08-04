import type { RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { SkillArtifactMaterializer } from '../domain/ports/skill-artifact-store.js';
import type { ToolchainArtifactMaterializer } from '../domain/ports/toolchain-artifact-store.js';
import type { WorkerRegistryRepository } from '../domain/ports/worker-coordination.js';
import type { ManifestWakeupSource } from './toolchain-manifest-listener.js';
/** Capability id a worker advertises for an activated skill artifact. */
export declare function skillCapabilityId(skillId: string): string;
/** Capability id a worker advertises for an activated toolchain artifact. */
export declare function toolchainCapabilityId(manifestHash: string): string;
export interface ArtifactIntegrityAuditEvent {
    appId: string;
    kind: 'skill' | 'toolchain';
    capabilityId: string;
    storageRef: string;
    expectedContentHash: string;
    actualContentHash: string;
    quarantinePath: string;
}
export interface WorkerCapabilityReconcilerDeps {
    appId: string;
    workerInstanceId: string;
    runtimeDependencies: RuntimeDependencyRepository;
    skills: SkillCatalogRepository;
    toolchainMaterializer: ToolchainArtifactMaterializer;
    skillMaterializer: SkillArtifactMaterializer;
    workerRegistry: WorkerRegistryRepository;
    wakeupSource: ManifestWakeupSource;
    /** Local root for activated artifacts and quarantine. */
    localRoot: string;
    pollIntervalMs?: number;
    imageInventory?: () => string[];
    onIntegrityError?: (event: ArtifactIntegrityAuditEvent) => void;
    logWarn?: (context: Record<string, unknown>, message: string) => void;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
}
/**
 * Worker-side capability reconciler (fleet mode only). On a manifest NOTIFY or
 * the interval poll it lists uploaded/activated toolchains and skills with an
 * object-store artifact for the app, fetches + sha256-verifies + atomically
 * activates any it is missing or whose hash changed, and advertises the
 * satisfied capability ids in `worker_instances.capabilities_json` (merged with
 * the immutable image inventory). An integrity failure quarantines the artifact
 * (handled by the materializer), emits an audit event, and is NOT advertised.
 *
 * Started only in fleet mode; workstation never runs it (local installs are
 * unchanged). All background work is stoppable via {@link stop}.
 */
export declare class WorkerCapabilityReconciler {
    private readonly deps;
    private readonly activated;
    private unsubscribe;
    private pollTimer;
    private inFlight;
    private rerunRequested;
    private stopped;
    constructor(deps: WorkerCapabilityReconcilerDeps);
    start(): void;
    stop(): Promise<void>;
    /** Trigger a reconcile, coalescing overlapping wakeups into one in-flight run. */
    wake(): void;
    /** Run one full reconcile pass. Exposed for tests that await a single pass. */
    reconcile(): Promise<void>;
    private reconcileToolchains;
    private reconcileSkills;
    private advertise;
    private handleIntegrity;
}
