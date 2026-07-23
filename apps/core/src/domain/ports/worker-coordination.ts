import type {
  PermissionCallbackClaim,
  PermissionCallbackClaimReference,
  PermissionCallbackScope,
  PermissionRecoveryEnvelope,
} from '../types.js';
import type { LiveTurnCommandAppendInput } from './live-turns.js';

export type WorkerInstanceStatus =
  'starting' | 'healthy' | 'unhealthy' | 'draining' | 'stopped';

export interface WorkerInstance {
  id: string;
  imageDigest: string | null;
  bootNonce: string;
  version: string | null;
  capabilities: string[];
  /**
   * Deployment process role this worker registered as (`all | control |
   * live-worker | job-worker`). Typed as string here because the canonical role
   * union lives in the runtime layer; the domain port stays adapter/runtime-free.
   */
  processRole: string;
  status: WorkerInstanceStatus;
  heartbeatAt: string;
  lastSeenAt: string;
  createdAt: string;
}

export type RunLeaseStatus =
  'active' | 'expired' | 'released' | 'completed' | 'failed';

export interface RunLease {
  runId: string;
  jobId: string | null;
  workerInstanceId: string;
  leaseToken: string;
  fencingVersion: number;
  recoveredFromExpiredLease?: boolean;
  status: RunLeaseStatus;
  claimedAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface RecoveredRunLease {
  runId: string;
  jobId: string | null;
  workerInstanceId: string;
  fencingVersion: number;
  expiredAt: string;
}

export type RunnerControlEventType =
  | 'claimed'
  | 'heartbeat'
  | 'output'
  | 'log'
  | 'terminal_state'
  | 'permission_requested'
  | 'question_requested'
  | 'permission_resolved'
  | 'stop'
  | 'completed'
  | 'failed';

export type RunnerControlEventAppendResult =
  'persisted' | 'replayed' | 'fenced';

export interface RunnerControlEvent {
  id: string;
  runId: string;
  jobId: string | null;
  workerInstanceId: string;
  fencingVersion: number;
  eventType: RunnerControlEventType;
  payload: Record<string, unknown>;
  nonce: string;
  createdAt: string;
  exposedAt: string | null;
}

export type PendingInteractionKind = 'permission' | 'question';

export type PendingInteractionStatus =
  'pending' | 'resolved' | 'expired' | 'cancelled';

export interface PendingInteraction {
  id: string;
  appId: string;
  runId: string | null;
  sourceAgentFolder: string | null;
  requestId: string | null;
  runLeaseToken: string | null;
  runLeaseFencingVersion: number | null;
  envelopeId: string | null;
  memberIndex: number | null;
  kind: PendingInteractionKind;
  status: PendingInteractionStatus;
  payload: Record<string, unknown>;
  callbackRoute: Record<string, unknown> | null;
  idempotencyKey: string;
  approverRef: string | null;
  resolution: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
}

export type PermissionPromptSettlementState =
  'open' | 'claimed' | 'settled' | 'review_each_expired' | 'superseded';

export interface PermissionPrompt {
  id: string;
  parentEnvelopeId: string | null;
  appId: string;
  sourceAgentFolder: string;
  interactionId: string;
  matchKind: 'individual' | 'batch';
  memberCount: number;
  envelope: PermissionRecoveryEnvelope;
  fullView: Record<string, unknown> | null;
  externalPromptProvider: string | null;
  externalPromptConversationId: string | null;
  externalPromptMessageId: string | null;
  externalPromptThreadId: string | null;
  providerAliases: string[];
  claim: PermissionCallbackClaim | null;
  settlementState: PermissionPromptSettlementState;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionPromptGroup {
  prompt: PermissionPrompt;
  members: PendingInteraction[];
}

export interface TransientGrant {
  id: string;
  appId: string;
  runId: string;
  leaseToken: string;
  grant: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export interface WorkerRegistryRepository {
  registerWorker(input: {
    id: string;
    bootNonce: string;
    imageDigest?: string | null;
    version?: string | null;
    capabilities?: string[];
    /** Defaults to `'all'` when omitted (workstation single-process default). */
    processRole?: string;
    now?: string;
  }): Promise<void>;
  heartbeatWorker(input: { id: string; now?: string }): Promise<boolean>;
  markStaleWorkersUnhealthy(input: { staleBefore: string }): Promise<string[]>;
  getWorker(id: string): Promise<WorkerInstance | null>;
  /** List all registered worker instances, most-recent heartbeat first. */
  listWorkers(): Promise<WorkerInstance[]>;
  /**
   * Advertised capability sets of workers whose heartbeat is fresh (within
   * `staleBefore`). Used by fleet-wide readiness and capability-starvation
   * checks to decide whether ANY active worker can run a required set, without
   * a SQL set-containment query — the caller compares in application code.
   */
  listActiveWorkerCapabilities(input: {
    staleBefore: string;
  }): Promise<string[][]>;
  /**
   * Replace this worker's advertised capability id set in
   * `worker_instances.capabilities_json`. Called by the capability reconciler
   * after it fetches/verifies/activates artifacts locally; dispatch routes work
   * only to workers whose advertised set covers the run's required capabilities.
   * Returns false when the worker row no longer exists.
   */
  advertiseWorkerCapabilities(input: {
    id: string;
    capabilities: string[];
    now?: string;
  }): Promise<boolean>;
}

export interface RunLeaseRepository {
  /**
   * Transactionally claim execution of a run. Returns the lease (token +
   * fencing version) on success, or null when another worker holds a live
   * lease on the run or its job. A lapsed prior lease is marked expired and
   * the new lease is issued at a strictly higher fencing version.
   */
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
  /** Lease-fenced terminal write. False means the caller lost the lease. */
  settleRunLease(input: {
    runId: string;
    leaseToken: string;
    workerInstanceId?: string;
    fencingVersion?: number;
    outcome: 'completed' | 'failed' | 'released';
    now?: string;
    allowAlreadySettled?: boolean;
  }): Promise<boolean>;
  getActiveRunLease(input: {
    runId: string;
    now?: string;
  }): Promise<RunLease | null>;
  /**
   * Stale recovery: expires only leases whose expiry/heartbeat has lapsed.
   * Live leases held by healthy workers are never touched.
   */
  recoverExpiredRunLeases(input: {
    now?: string;
    staleBefore?: string;
  }): Promise<RecoveredRunLease[]>;
}

export interface RunSlotRepository {
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
  releaseRunSlot(input: { slotKey: string; holderId: string }): Promise<void>;
  releaseRunSlotsForStaleWorkers?(input: {
    staleBefore: string;
  }): Promise<number>;
}

export interface RunnerControlEventRepository {
  /**
   * Persist a runner-control event. Idempotent and replay-protected: a reused
   * nonce returns 'replayed'; a lease token that is not the run's active lease
   * returns 'fenced'. Terminal-state events are the only exception: they may be
   * appended after the same token settles into a terminal lease status. Only
   * 'persisted' events may be exposed externally.
   */
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
  pruneRunnerControlNonces(input: { now?: string }): Promise<number>;
}

export interface PendingInteractionRepository {
  /**
   * Durable interaction record, created before any provider prompt renders.
   * Idempotent on idempotencyKey: a duplicate create returns the existing row.
   */
  createPendingInteraction(input: {
    id: string;
    appId: string;
    runId?: string | null;
    sourceAgentFolder: string;
    requestId: string;
    runLeaseToken?: string | null;
    runLeaseFencingVersion?: number | null;
    kind: PendingInteractionKind;
    payload: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    idempotencyKey: string;
    expiresAt: string;
    now?: string;
  }): Promise<PendingInteraction>;
  resolvePendingInteraction(input: {
    idempotencyKey: string;
    status: Extract<PendingInteractionStatus, 'resolved' | 'cancelled'>;
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    permissionCallbackClaim?: PermissionCallbackClaimReference | null;
    liveTurnCommand?: LiveTurnCommandAppendInput | null;
    now?: string;
  }): Promise<boolean>;
  cancelPendingQuestionInteractionIfRunLeaseInactive(input: {
    id: string;
    resolution: Record<string, unknown>;
    now?: string;
  }): Promise<boolean>;
  updatePendingInteractionPayload(input: {
    idempotencyKey: string;
    update: (
      payload: Record<string, unknown>,
    ) => Record<string, unknown> | null;
  }): Promise<boolean>;
  bindPendingPermissionPrompt(input: {
    id: string;
    appId: string;
    sourceAgentFolder: string;
    interactionId: string;
    matchKind: 'individual' | 'batch';
    members: Array<{
      idempotencyKey: string;
      requestId: string;
      index: number;
    }>;
    envelope: PermissionRecoveryEnvelope;
    fullView?: Record<string, unknown> | null;
    externalPromptProvider?: string | null;
    externalPromptConversationId?: string | null;
    externalPromptMessageId?: string | null;
    externalPromptThreadId?: string | null;
    providerAliases: string[];
    now?: string;
  }): Promise<PermissionPromptGroup | null>;
  claimPendingPermissionCallback(input: {
    claim: PermissionCallbackClaim;
  }): Promise<PermissionPromptGroup | null>;
  releasePendingPermissionCallback(input: {
    claim: PermissionCallbackClaimReference;
  }): Promise<boolean>;
  settlePendingPermissionCallback(input: {
    claim: PermissionCallbackClaimReference;
  }): Promise<boolean>;
  expirePendingPermissionReviewEach(input: {
    claim: PermissionCallbackClaimReference;
    now?: string;
  }): Promise<PermissionPromptGroup | null>;
  findPendingPermissionPrompt(input: {
    scope: PermissionCallbackScope;
    now?: string;
    includeTerminalSettlement?: boolean;
  }): Promise<PermissionPromptGroup | null>;
  findPendingPermissionPromptByMember(input: {
    appId: string;
    sourceAgentFolder: string;
    requestId: string;
    now?: string;
  }): Promise<PermissionPromptGroup | null>;
  findPendingPermissionPromptByMessage(input: {
    appId: string;
    provider: string;
    conversationId: string;
    externalMessageId: string;
    threadId?: string | null;
    now?: string;
  }): Promise<PermissionPromptGroup | null>;
  findPendingInteractionByRequest(input: {
    appId: string;
    kind: PendingInteractionKind;
    sourceAgentFolder?: string;
    requestId: string;
    now?: string;
  }): Promise<PendingInteraction | null>;
  findPendingInteractionByIdempotencyKey(input: {
    appId: string;
    idempotencyKey: string;
    runId?: string | null;
    now?: string;
  }): Promise<PendingInteraction | null>;
  listPendingInteractions(input: {
    appId: string;
    runId?: string | null;
    now?: string;
  }): Promise<PendingInteraction[]>;
}

export interface TransientGrantRepository {
  /**
   * Run-scoped, never durable authority. The grant is bound to the active
   * lease token and is unreadable once that lease is no longer active.
   */
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

export interface WorkerCoordinationRepository
  extends
    WorkerRegistryRepository,
    RunLeaseRepository,
    RunSlotRepository,
    RunnerControlEventRepository,
    PendingInteractionRepository,
    TransientGrantRepository {}
