import type { RuntimeDependency, RuntimeDependencyRepository, RuntimeDependencyStatus, StaleRuntimeDependencyLister, UpdateRuntimeDependencyStatusInput } from '../../../../domain/ports/fleet-capability-state.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresRuntimeDependencyRepository implements RuntimeDependencyRepository, StaleRuntimeDependencyLister {
    private readonly db;
    constructor(db: CanonicalDb);
    createRuntimeDependency(input: {
        id: string;
        appId: string;
        manifestHash: string;
        requestedPackages: string[];
        requestedByAgentId?: string | null;
        approvedByConversationId?: string | null;
        approvedAt?: string | null;
        now?: string;
    }): Promise<RuntimeDependency>;
    getRuntimeDependency(id: string): Promise<RuntimeDependency | null>;
    getRuntimeDependencyByManifestHash(input: {
        appId: string;
        manifestHash: string;
    }): Promise<RuntimeDependency | null>;
    listRuntimeDependencies(input: {
        appId: string;
        statuses?: RuntimeDependencyStatus[];
    }): Promise<RuntimeDependency[]>;
    listStaleRuntimeDependencies(input: {
        statuses: RuntimeDependencyStatus[];
        updatedBefore: string;
    }): Promise<RuntimeDependency[]>;
    updateRuntimeDependencyStatus(input: UpdateRuntimeDependencyStatusInput): Promise<boolean>;
}
