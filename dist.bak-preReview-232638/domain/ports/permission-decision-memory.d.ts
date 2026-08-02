import type { PermissionApprovalDecisionMode, PermissionRiskCategory, PermissionRiskLevel } from '../types.js';
export type PermissionDecisionMemoryKind = 'classifier_verdict' | 'remembered_deny' | 'trusted_root' | 'standing_grant';
/** Persistable decision effect. Human `allow_once` is NEVER one of these. */
export type PermissionDecisionMemoryEffect = 'allow' | 'ask' | 'deny';
export interface PermissionDecisionMemoryRow {
    id: string;
    appId: string;
    agentFolder: string;
    kind: PermissionDecisionMemoryKind;
    lookupIdentity: string;
    effectHash?: string;
    decision?: PermissionDecisionMemoryEffect;
    reason: string;
    risk_level?: PermissionRiskLevel;
    risk_category?: PermissionRiskCategory;
    canonicalRoot?: string;
    principal?: string;
    effectSchemaVersion: number;
    railVersion: number;
    provenance: string;
    createdAt: string;
    expiresAt?: string;
    revokedAt?: string;
}
/** Input to the single write path. `sourceMode` lets the guard reject a human `allow_once`. */
export interface PermissionDecisionMemoryPutInput {
    id: string;
    appId: string;
    agentFolder: string;
    kind: PermissionDecisionMemoryKind;
    lookupIdentity: string;
    reason: string;
    risk_level?: PermissionRiskLevel;
    risk_category?: PermissionRiskCategory;
    effectSchemaVersion: number;
    railVersion: number;
    provenance: string;
    nowIso: string;
    effectHash?: string;
    decision?: PermissionDecisionMemoryEffect;
    canonicalRoot?: string;
    principal?: string;
    expiresAt?: string;
    /** If this originated from a human prompt, its mode — an `allow_once` is refused. */
    sourceMode?: PermissionApprovalDecisionMode;
}
/** A cached classifier verdict — only `allow`/`ask`, never a human ephemeral decision. */
export interface ClassifierVerdict {
    decision: 'allow' | 'ask';
    reason: string;
    risk_level: PermissionRiskLevel;
    risk_category?: PermissionRiskCategory;
}
/**
 * Thrown by the write path when a human `allow_once` is offered for persistence.
 * allow_once is ephemeral and must never enter decision memory.
 */
export declare class AllowOnceNeverPersistedError extends Error {
    constructor();
}
export interface PermissionDecisionMemoryRepository {
    /** Reuse a cached classifier verdict keyed by the versioned effect hash. */
    getClassifierVerdict(input: {
        appId: string;
        agentFolder: string;
        effectHash: string;
    }): Promise<ClassifierVerdict | null>;
    /** Write a classifier verdict back (cache-miss path). Refuses a human allow_once. */
    putClassifierVerdict(input: {
        appId: string;
        agentFolder: string;
        effectHash: string;
        decision: 'allow' | 'ask';
        reason: string;
        risk_level: PermissionRiskLevel;
        risk_category?: PermissionRiskCategory;
        effectSchemaVersion: number;
        railVersion: number;
        provenance: string;
        nowIso: string;
        id?: string;
        expiresAt?: string;
        sourceMode?: PermissionApprovalDecisionMode;
    }): Promise<void>;
    /** Single write path for the owner-authored kinds. Refuses a human allow_once. */
    put(input: PermissionDecisionMemoryPutInput): Promise<void>;
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
