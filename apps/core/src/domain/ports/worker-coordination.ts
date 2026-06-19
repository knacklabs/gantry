export type WorkerInstanceStatus =
  | 'starting'
  | 'healthy'
  | 'unhealthy'
  | 'draining'
  | 'stopped';

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
  | 'active'
  | 'expired'
  | 'released'
  | 'completed'
  | 'failed';

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
  | 'persisted'
  | 'replayed'
  | 'fenced';

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
  | 'pending'
  | 'resolved'
  | 'expired'
  | 'cancelled';

export interface PendingInteraction {
  id: string;
  appId: string;
  runId: string | null;
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
    now?: string;
  }): Promise<boolean>;
  updatePendingInteractionPayload(input: {
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): Promise<boolean>;
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
