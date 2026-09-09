import type {
  PermissionApprovalDecisionMode,
  PermissionRiskCategory,
  PermissionRiskLevel,
} from '../types.js';

export type PermissionDecisionMemoryKind =
  | 'classifier_verdict'
  | 'remembered_deny'
  | 'trusted_root'
  | 'standing_grant'
  | 'human_decision';

export const HumanDecisionOutcome = {
  Allow: 'allow',
  Deny: 'deny',
} as const;
export type HumanDecisionOutcome =
  (typeof HumanDecisionOutcome)[keyof typeof HumanDecisionOutcome];

export const HumanDecisionScope = {
  Exact: 'exact',
  Kind: 'kind',
  Place: 'place',
} as const;
export type HumanDecisionScope =
  (typeof HumanDecisionScope)[keyof typeof HumanDecisionScope];

export const HUMAN_DECISION_MEMORY_KIND = 'human_decision' as const;

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
  outcome?: HumanDecisionOutcome;
  scope?: HumanDecisionScope;
  scopeKey?: string;
  actingPersonId?: string;
  actingPersonLabel?: string;
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
  outcome?: HumanDecisionOutcome;
  scope?: HumanDecisionScope;
  scopeKey?: string;
  actingPersonId?: string;
  actingPersonLabel?: string;
  canonicalRoot?: string;
  principal?: string;
  expiresAt?: string;
  /** If this originated from a human prompt, its mode — an `allow_once` is refused. */
  sourceMode?: PermissionApprovalDecisionMode;
}

export interface HumanDecisionMemoryPutInput {
  id: string;
  appId: string;
  agentFolder: string;
  outcome: HumanDecisionOutcome;
  scope: HumanDecisionScope;
  scopeKey: string;
  actingPersonId: string;
  actingPersonLabel?: string;
  canonicalTool: string;
  reason: string;
  effectSchemaVersion: number;
  railVersion: number;
  provenance: string;
  nowIso: string;
  effectHash?: string;
}

export type HumanDecisionMemoryPutResult = {
  id: string;
  status: 'inserted' | 'refreshed';
};

export interface HumanDecisionMemoryCandidate {
  scope: HumanDecisionScope;
  scopeKey: string;
}

export type HumanDecisionRevokeResult =
  | 'applied'
  | 'already_revoked'
  | 'not_found';

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
export class AllowOnceNeverPersistedError extends Error {
  constructor() {
    super('permission_decision_memory: human allow_once is never persisted');
    this.name = 'AllowOnceNeverPersistedError';
  }
}

export class HumanDecisionRequiresTypedAccessError extends Error {
  constructor() {
    super(
      'permission_decision_memory: human decisions require person-scoped typed access',
    );
    this.name = 'HumanDecisionRequiresTypedAccessError';
  }
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

  putHumanDecision(
    input: HumanDecisionMemoryPutInput,
  ): Promise<HumanDecisionMemoryPutResult>;

  listHumanDecisions(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    includeRevoked?: boolean;
  }): Promise<PermissionDecisionMemoryRow[]>;

  findHumanDecision(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    candidates: HumanDecisionMemoryCandidate[];
    railVersion: number;
  }): Promise<PermissionDecisionMemoryRow | null>;

  revokeById(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    recordId: string;
    nowIso: string;
  }): Promise<HumanDecisionRevokeResult>;

  countExactAllowsByTool(input: {
    appId: string;
    agentFolder: string;
    actingPersonId: string;
    railVersion: number;
  }): Promise<Record<string, number>>;

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
