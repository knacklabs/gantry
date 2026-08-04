import { type ClassifierVerdict, type PermissionDecisionMemoryKind, type PermissionDecisionMemoryPutInput, type PermissionDecisionMemoryRepository, type PermissionDecisionMemoryRow } from '../../../../domain/ports/permission-decision-memory.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresPermissionDecisionMemoryRepository implements PermissionDecisionMemoryRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    put(input: PermissionDecisionMemoryPutInput): Promise<void>;
    putClassifierVerdict(input: {
        appId: string;
        agentFolder: string;
        effectHash: string;
        decision: 'allow' | 'ask';
        reason: string;
        risk_level: NonNullable<PermissionDecisionMemoryPutInput['risk_level']>;
        risk_category?: PermissionDecisionMemoryPutInput['risk_category'];
        effectSchemaVersion: number;
        railVersion: number;
        provenance: string;
        nowIso: string;
        id?: string;
        expiresAt?: string;
        sourceMode?: string;
    }): Promise<void>;
    getClassifierVerdict(input: {
        appId: string;
        agentFolder: string;
        effectHash: string;
    }): Promise<ClassifierVerdict | null>;
    get(input: {
        appId: string;
        agentFolder: string;
        kind: PermissionDecisionMemoryKind;
        lookupIdentity: string;
    }): Promise<PermissionDecisionMemoryRow | null>;
    list(input: {
        appId: string;
        agentFolder: string;
        kind?: PermissionDecisionMemoryKind;
    }): Promise<PermissionDecisionMemoryRow[]>;
    revoke(input: {
        appId: string;
        agentFolder: string;
        kind: PermissionDecisionMemoryKind;
        lookupIdentity: string;
        nowIso: string;
    }): Promise<boolean>;
}
