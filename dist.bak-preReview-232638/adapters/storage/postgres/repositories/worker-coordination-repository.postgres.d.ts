import type { LiveTurnCommandNotifier } from '../../../../domain/ports/live-turns.js';
import type { RecoveredRunLease, RunLease, RunnerControlEvent, RunnerControlEventAppendResult, RunnerControlEventType, TransientGrant, WorkerCoordinationRepository, WorkerInstance } from '../../../../domain/ports/worker-coordination.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import { PostgresInteractionRepositoryMethods } from './worker-coordination-interaction-repository.postgres.js';
export declare class PostgresWorkerCoordinationRepository extends PostgresInteractionRepositoryMethods implements WorkerCoordinationRepository {
    constructor(db: CanonicalDb, commandNotifier?: LiveTurnCommandNotifier);
    registerWorker(input: {
        id: string;
        bootNonce: string;
        imageDigest?: string | null;
        version?: string | null;
        capabilities?: string[];
        processRole?: string;
        now?: string;
    }): Promise<void>;
    heartbeatWorker(input: {
        id: string;
        now?: string;
    }): Promise<boolean>;
    advertiseWorkerCapabilities(input: {
        id: string;
        capabilities: string[];
        now?: string;
    }): Promise<boolean>;
    markStaleWorkersUnhealthy(input: {
        staleBefore: string;
    }): Promise<string[]>;
    listActiveWorkerCapabilities(input: {
        staleBefore: string;
    }): Promise<string[][]>;
    getWorker(id: string): Promise<WorkerInstance | null>;
    listWorkers(): Promise<WorkerInstance[]>;
    claimRunLease(input: {
        runId: string;
        jobId?: string | null;
        workerInstanceId: string;
        ttlMs: number;
        now?: string;
    }): Promise<RunLease | null>;
    heartbeatRunLease(input: {
        runId: string;
        leaseToken: string;
        ttlMs: number;
        now?: string;
    }): Promise<boolean>;
    settleRunLease(input: {
        runId: string;
        leaseToken: string;
        outcome: 'completed' | 'failed' | 'released';
        now?: string;
        allowAlreadySettled?: boolean;
    }): Promise<boolean>;
    getActiveRunLease(input: {
        runId: string;
        now?: string;
    }): Promise<RunLease | null>;
    recoverExpiredRunLeases(input: {
        now?: string;
        staleBefore?: string;
    }): Promise<RecoveredRunLease[]>;
    acquireRunSlot(input: {
        slotKey: string;
        holderId: string;
        capacity: number;
        ttlMs: number;
        runId?: string | null;
        workerInstanceId?: string | null;
        now?: string;
    }): Promise<boolean>;
    renewRunSlot(input: {
        slotKey: string;
        holderId: string;
        ttlMs: number;
        now?: string;
    }): Promise<boolean>;
    releaseRunSlot(input: {
        slotKey: string;
        holderId: string;
    }): Promise<void>;
    releaseRunSlotsForStaleWorkers(input: {
        staleBefore: string;
    }): Promise<number>;
    appendRunnerControlEvent(input: {
        id: string;
        runId: string;
        jobId?: string | null;
        leaseToken: string;
        eventType: RunnerControlEventType;
        payload?: Record<string, unknown>;
        nonce: string;
        nonceTtlMs?: number;
        now?: string;
    }): Promise<RunnerControlEventAppendResult>;
    listUnexposedRunnerControlEvents(input: {
        limit: number;
    }): Promise<RunnerControlEvent[]>;
    markRunnerControlEventsExposed(input: {
        ids: string[];
        now?: string;
    }): Promise<void>;
    pruneRunnerControlNonces(input: {
        now?: string;
    }): Promise<number>;
    createTransientGrant(input: {
        id: string;
        appId: string;
        runId: string;
        leaseToken: string;
        grant: Record<string, unknown>;
        expiresAt: string;
        now?: string;
    }): Promise<boolean>;
    listActiveTransientGrants(input: {
        runId: string;
        now?: string;
    }): Promise<TransientGrant[]>;
}
