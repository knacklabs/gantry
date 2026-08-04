import type { RuntimeDependency, RuntimeDependencyRepository } from '../domain/ports/fleet-capability-state.js';
export interface ToolchainBakeQueuePort {
    /** Enqueue a bake for a runtime_dependencies row (pg-boss in production). */
    enqueueBake(input: {
        dependencyId: string;
        manifestHash: string;
    }): Promise<void>;
}
export interface EnqueueToolchainBakeDeps {
    runtimeDependencies: RuntimeDependencyRepository;
    queue: ToolchainBakeQueuePort;
    registry: string;
}
export type EnqueueToolchainBakeResult = {
    status: 'enqueued';
    dependency: RuntimeDependency;
    deduplicated: false;
} | {
    status: 'already_present';
    dependency: RuntimeDependency;
    deduplicated: true;
};
/**
 * Idempotent toolchain bake enqueue. Validates the npm manifest (npm-only;
 * system packages rejected with the ADR-2 error), computes the manifest hash,
 * and creates the runtime_dependencies row. Because the row is idempotent on
 * (appId, manifestHash), a concurrent or repeated request collapses onto the
 * existing row: a non-`failed` existing row short-circuits (no duplicate bake);
 * a previously-failed row is re-enqueued so an operator can retry by re-approving.
 */
export declare function enqueueToolchainBake(deps: EnqueueToolchainBakeDeps, input: {
    appId: string;
    packages: string[];
    requestedByAgentId?: string | null;
    approvedByConversationId?: string | null;
    approvedAt?: string | null;
}): Promise<EnqueueToolchainBakeResult>;
