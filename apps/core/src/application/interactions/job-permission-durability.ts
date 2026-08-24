import type {
  JobPermissionActorContext,
  JobPermissionDurabilityRepository,
  JobPermissionWaiter,
} from '../../domain/ports/job-permission-durability.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
import {
  initialCard,
  reviseLivingCard,
} from './job-permission-card-projection.js';
import {
  canonicalAtoms,
  jobPermissionNeedId,
  jobPermissionResponseId,
} from './job-permission-durability-state.js';
import { JobPermissionProviderActions } from './job-permission-provider-actions.js';
import { JobPermissionReconciler } from './job-permission-reconciler.js';

export {
  advancePendingBudget,
  canonicalJobPermissionNeedIdentity,
  jobPermissionCardCallbackKey,
  jobPermissionCardId,
  jobPermissionNeedId,
  jobPermissionRecordExpiresAt,
} from './job-permission-durability-state.js';

export interface JobPermissionCardCapacity {
  maxRows: number;
  maxGrantAtomsPerRow: number;
}

export interface JobPermissionRevalidationResult {
  kind: 'approved' | 'reask' | 'cancelled';
  grantAtoms?: string[];
  displayLabel?: string;
  reason?: string;
}

export interface JobPermissionDurabilityEffects {
  authorizeActor(
    input: {
      appId: string;
      jobId: string;
    } & JobPermissionActorContext,
  ): Promise<boolean>;
  releaseSlot(input: {
    runId: string;
    waiterId: string;
    leaseToken: string;
    fencingVersion: number;
  }): Promise<boolean>;
  acquireSlot(input: {
    runId: string;
    waiterId: string;
    leaseToken: string;
    fencingVersion: number;
  }): Promise<boolean>;
  isRunAlive(input: {
    runId: string;
    leaseToken: string;
    fencingVersion: number;
  }): Promise<boolean>;
  revalidate(input: {
    appId: string;
    jobId: string;
    needId: string;
    askingEpoch: number;
    renderedGrantAtoms: readonly string[];
  }): Promise<JobPermissionRevalidationResult>;
  persistGrant(input: {
    idempotencyKey: string;
    appId: string;
    jobId: string;
    needId: string;
    askingEpoch: number;
    grantAtoms: readonly string[];
    decidedBy: string;
  }): Promise<void>;
  deliverWaiterResponse(input: {
    responseId: string;
    appId: string;
    sourceAgentFolder: string;
    waiter: JobPermissionWaiter;
    response:
      | { kind: 'approved'; grantAtoms: readonly string[] }
      | { kind: 'denied'; reason: string }
      | { kind: 'policy_changed'; reason: string }
      | { kind: 'setup_required'; reason: string };
  }): Promise<void>;
  enqueueRunAgain(input: {
    idempotencyKey: string;
    appId: string;
    jobId: string;
    priorRunId: string;
  }): Promise<void>;
}

export interface JobPermissionDurabilityClock {
  now(): string;
  monotonicMs(): number;
  hostBootId(): string;
}

export interface JobPermissionDurabilityDependencies {
  repository: JobPermissionDurabilityRepository;
  effects: JobPermissionDurabilityEffects;
  clock: JobPermissionDurabilityClock;
  capacity: JobPermissionCardCapacity;
}

export type AttachJobPermissionNeedOutcome =
  | {
      status: 'asking';
      needId: string;
      askingEpoch: number;
      cardRevision: number;
    }
  | { status: 'applied'; needId: string }
  | { status: 'denied'; needId: string; reason: string }
  | { status: 'handoff'; needId: string; reason: string };

export type JobPermissionCardDecisionOutcome =
  | { status: 'accepted'; needIds: string[] }
  | { status: 'unauthorized' | 'stale' | 'already_decided' };

export interface JobPermissionCardActionInput {
  actor: JobPermissionActorContext;
  providerMessageId?: string;
  token: string;
  reason?: string;
}

export class JobPermissionDurabilityService {
  private readonly providerActions: JobPermissionProviderActions;
  private readonly reconciler: JobPermissionReconciler;

  constructor(
    private readonly repository: JobPermissionDurabilityRepository,
    private readonly effects: JobPermissionDurabilityEffects,
    private readonly clock: JobPermissionDurabilityClock,
    private readonly capacity: JobPermissionCardCapacity,
  ) {
    if (
      !Number.isInteger(capacity.maxRows) ||
      capacity.maxRows <= 0 ||
      !Number.isInteger(capacity.maxGrantAtomsPerRow) ||
      capacity.maxGrantAtomsPerRow <= 0
    ) {
      throw new Error('Job permission card capacity must be positive.');
    }
    const dependencies: JobPermissionDurabilityDependencies = {
      repository,
      effects,
      clock,
      capacity,
    };
    this.providerActions = new JobPermissionProviderActions(dependencies);
    this.reconciler = new JobPermissionReconciler(
      dependencies,
      this.providerActions,
    );
  }

  async attachNeed(input: {
    appId: string;
    jobId: string;
    sourceAgentFolder: string;
    conversationId: string;
    threadId?: string | null;
    agentId?: string | null;
    canonicalIdentity: string;
    displayLabel: string;
    renderedGrantAtoms: string[];
    requestSnapshot?: PermissionApprovalRequest;
    waiter: {
      id: string;
      requestId: string;
      runId: string;
      runLeaseToken: string;
      runLeaseFencingVersion: number;
    };
  }): Promise<AttachJobPermissionNeedOutcome> {
    const canonicalIdentity = input.canonicalIdentity.trim();
    const renderedGrantAtoms = canonicalAtoms(input.renderedGrantAtoms);
    if (!canonicalIdentity || renderedGrantAtoms.length === 0) {
      throw new Error('A job permission need requires canonical grant scope.');
    }
    const now = this.clock.now();
    const needId = jobPermissionNeedId(
      input.appId,
      input.jobId,
      canonicalIdentity,
    );
    return this.repository.mutateJobPermissionState<AttachJobPermissionNeedOutcome>(
      {
        appId: input.appId,
        jobId: input.jobId,
        initialCard: initialCard(input, now),
        mutate: (state) => {
          let need = state.needs.find(
            (candidate) => candidate.canonicalIdentity === canonicalIdentity,
          );
          if (need?.state === 'applied') {
            return { state, result: { status: 'applied', needId } as const };
          }
          if (need?.state === 'denied') {
            return {
              state,
              result: {
                status: 'denied',
                needId,
                reason: need.denialReason ?? 'This permission was denied.',
              } as const,
            };
          }
          if (!need) {
            need = {
              schemaVersion: 1,
              recordType: 'job_permission_need',
              id: needId,
              appId: input.appId,
              jobId: input.jobId,
              sourceAgentFolder: input.sourceAgentFolder,
              canonicalIdentity,
              displayLabel: input.displayLabel,
              askingEpoch: 1,
              state: 'asking',
              renderedGrantAtoms,
              approvedGrantAtoms: null,
              waitStartedAt: null,
              decidedAt: null,
              decidedBy: null,
              denialReason: null,
              policyChangedReason: null,
              grantAppliedAt: null,
              requestSnapshots: [],
              waiters: [],
              createdAt: now,
              updatedAt: now,
            };
            state.needs.push(need);
          }
          if (
            input.requestSnapshot &&
            !need.requestSnapshots.some(
              (snapshot) =>
                snapshot.requestId === input.requestSnapshot!.requestId,
            )
          ) {
            need.requestSnapshots.push({
              requestId: input.requestSnapshot.requestId,
              request: structuredClone(input.requestSnapshot),
            });
          }
          if (
            need.state !== 'asking' &&
            need.state !== 'approved_pending_apply' &&
            need.state !== 'denied_pending_delivery' &&
            need.state !== 'handoff_pending' &&
            need.state !== 'handed_off'
          ) {
            throw new Error(`Cannot attach a waiter to ${need.state}.`);
          }
          const handedOff =
            need.state === 'handoff_pending' || need.state === 'handed_off';
          if (!need.waiters.some((waiter) => waiter.id === input.waiter.id)) {
            need.waiters.push({
              ...input.waiter,
              responseId: jobPermissionResponseId(
                need.id,
                need.askingEpoch,
                input.waiter.id,
              ),
              state: handedOff
                ? 'handoff'
                : need.waitStartedAt
                  ? 'release_pending'
                  : 'awaiting_card_delivery',
              slotReleased: false,
              responseDeliveredAt: null,
              createdAt: now,
              updatedAt: now,
            });
            need.updatedAt = now;
          }
          reviseLivingCard(state, this.capacity, now);
          if (handedOff) {
            return {
              state,
              result: {
                status: 'handoff',
                needId: need.id,
                reason:
                  'This permission is waiting on the durable job card; approve it to run the job again.',
              } as const,
            };
          }
          return {
            state,
            result: {
              status: 'asking',
              needId: need.id,
              askingEpoch: need.askingEpoch,
              cardRevision: state.card.revision,
            } as const,
          };
        },
      },
    );
  }

  async confirmCardDelivery(input: {
    appId: string;
    jobId: string;
    sourceAgentFolder: string;
    revision: number;
    provider: string;
    providerMessageId: string;
    deliveredAt?: string;
  }): Promise<boolean> {
    return this.providerActions.confirmCardDelivery(input);
  }

  async decideCard(input: {
    appId: string;
    jobId: string;
    sourceAgentFolder: string;
    actorRef: string;
    actorContext?: Omit<JobPermissionActorContext, 'actorRef'>;
    revision: number;
    decision: 'allow' | 'deny';
    needId?: string;
    askingEpoch?: number;
    batch?: boolean;
    reason?: string;
    providerMessageId?: string;
  }): Promise<JobPermissionCardDecisionOutcome> {
    return this.providerActions.decideCard(input);
  }

  async decideCardAction(
    input: JobPermissionCardActionInput,
  ): Promise<JobPermissionCardDecisionOutcome> {
    return this.providerActions.decideCardAction(input);
  }

  async showFullScope(input: {
    appId: string;
    jobId: string;
    sourceAgentFolder: string;
    actorRef: string;
    actorContext?: Omit<JobPermissionActorContext, 'actorRef'>;
    revision: number;
    needId: string;
    askingEpoch: number;
    providerMessageId?: string;
  }): Promise<JobPermissionCardDecisionOutcome> {
    return this.providerActions.showFullScope(input);
  }

  async showNextPage(input: {
    appId: string;
    jobId: string;
    sourceAgentFolder: string;
    actorRef: string;
    actorContext?: Omit<JobPermissionActorContext, 'actorRef'>;
    revision: number;
    providerMessageId?: string;
  }): Promise<JobPermissionCardDecisionOutcome> {
    return this.providerActions.showNextPage(input);
  }

  async reconsider(input: {
    appId: string;
    jobId: string;
    sourceAgentFolder: string;
    actorRef: string;
    actorContext?: Omit<JobPermissionActorContext, 'actorRef'>;
    revision: number;
    needId: string;
    askingEpoch: number;
    providerMessageId?: string;
  }): Promise<JobPermissionCardDecisionOutcome> {
    return this.providerActions.reconsider(input);
  }

  async recordPendingHeartbeat(input: {
    appId: string;
    jobId: string;
    sourceAgentFolder: string;
    runId: string;
    hostBootId?: string;
    monotonicMs?: number;
    maxDeltaMs?: number;
  }): Promise<number> {
    return this.providerActions.recordPendingHeartbeat(input);
  }

  async pendingLeaseExtensionMs(input: {
    appId: string;
    jobId: string;
    runId: string;
    hostBootId?: string;
    monotonicMs?: number;
    maxDeltaMs?: number;
  }): Promise<number> {
    return this.providerActions.pendingLeaseExtensionMs(input);
  }

  async reconcile(limit = 100): Promise<number> {
    return this.reconciler.reconcile(limit);
  }
}
