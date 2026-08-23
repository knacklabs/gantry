import type {
  JobPermissionCardRecord,
  JobPermissionCardRevision,
  JobPermissionCardRowSnapshot,
  JobPermissionActorContext,
  JobPermissionDurabilityRepository,
  JobPermissionDurabilityState,
  JobPermissionNeedRecord,
  JobPermissionPendingBudget,
  JobPermissionWaiter,
} from '../../domain/ports/job-permission-durability.js';
import {
  parseJobPermissionCardAction,
  type ParsedJobPermissionCardAction,
} from '../../domain/job-permission-card-actions.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
import { sha256Hex } from '../../shared/stable-hash.js';

const MAX_WAIT_MS = 24 * 60 * 60_000;
const NEVER_EXPIRES_AT = '9999-12-31T23:59:59.999Z';

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
    const now = this.clock.now();
    const deliveredAt = input.deliveredAt ?? now;
    return this.repository.mutateJobPermissionState<boolean>({
      appId: input.appId,
      jobId: input.jobId,
      initialCard: initialCard(input, now),
      mutate: (state) => {
        const revision = state.card.revisions.find(
          (candidate) => candidate.revision === input.revision,
        );
        if (!revision || revision.operation === 'retire') {
          return { state, result: false };
        }
        if (revision.revision >= state.card.currentProviderRevision) {
          state.card.currentProvider = input.provider;
          state.card.currentProviderMessageId = input.providerMessageId;
          state.card.currentProviderRevision = revision.revision;
        }
        for (const row of revision.rows) {
          const need = state.needs.find(
            (candidate) =>
              candidate.id === row.needId &&
              candidate.askingEpoch === row.askingEpoch &&
              candidate.state === 'asking',
          );
          if (!need) continue;
          need.waitStartedAt ??= deliveredAt;
          for (const waiter of need.waiters) {
            if (waiter.state === 'awaiting_card_delivery') {
              waiter.state = 'release_pending';
              waiter.updatedAt = now;
            }
          }
          need.updatedAt = now;
        }
        state.card.updatedAt = now;
        return { state, result: true };
      },
    });
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
    if (
      !(await this.effects.authorizeActor({
        appId: input.appId,
        jobId: input.jobId,
        actorRef: input.actorRef,
        ...input.actorContext,
      }))
    ) {
      return { status: 'unauthorized' };
    }
    const now = this.clock.now();
    return this.repository.mutateJobPermissionState<JobPermissionCardDecisionOutcome>(
      {
        appId: input.appId,
        jobId: input.jobId,
        initialCard: initialCard(input, now),
        mutate: (state) => {
          const revision = state.card.revisions.find(
            (candidate) => candidate.revision === input.revision,
          );
          if (!revision) return { state, result: { status: 'stale' } as const };
          recordConfirmedCardCallback(
            state,
            revision,
            input.providerMessageId,
            now,
          );
          const rows = input.batch
            ? revision.rows.filter(
                (row) =>
                  revision.batchNeedIds.includes(row.needId) &&
                  row.action === 'allow_and_continue' &&
                  row.actionEnabled,
              )
            : revision.rows.filter(
                (row) =>
                  row.needId === input.needId &&
                  row.askingEpoch === input.askingEpoch &&
                  (input.decision === 'deny'
                    ? row.denyEnabled
                    : row.action !== 'show_scope' && row.actionEnabled),
              );
          if (rows.length === 0) {
            return { state, result: { status: 'stale' } as const };
          }
          if (input.batch && input.decision !== 'allow') {
            return { state, result: { status: 'stale' } as const };
          }
          const accepted: string[] = [];
          for (const row of rows) {
            const need = state.needs.find(
              (candidate) =>
                candidate.id === row.needId &&
                candidate.askingEpoch === row.askingEpoch,
            );
            if (!need) continue;
            const wasHandoff =
              need.state === 'handoff_pending' || need.state === 'handed_off';
            const hasHandoffWaiter = need.waiters.some(
              (waiter) => waiter.state === 'handoff',
            );
            if (input.batch && hasHandoffWaiter) continue;
            const decisionable = need.state === 'asking' || wasHandoff;
            if (!decisionable) continue;
            need.decidedAt = now;
            need.decidedBy = input.actorRef;
            need.updatedAt = now;
            if (input.decision === 'allow') {
              need.state =
                need.state === 'handoff_pending'
                  ? 'handoff_pending'
                  : 'approved_pending_apply';
              need.approvedGrantAtoms = [...row.renderedGrantAtoms];
              need.denialReason = null;
              need.policyChangedReason = null;
              if (row.action === 'approve_and_run_again') {
                for (const runId of new Set(
                  need.waiters
                    .filter((waiter) =>
                      ['handoff', 'retired'].includes(waiter.state),
                    )
                    .map((waiter) => waiter.runId),
                )) {
                  recordRerunConsent(state, need, runId, input.actorRef, now);
                }
              }
            } else {
              removePendingRerunBarriersForNeed(
                state.card,
                need.id,
                need.askingEpoch,
              );
              need.state =
                need.state === 'handoff_pending'
                  ? 'handoff_pending'
                  : 'denied_pending_delivery';
              need.denialReason =
                input.reason ?? `Denied by ${input.actorRef} for this job.`;
            }
            accepted.push(need.id);
          }
          if (accepted.length === 0) {
            return {
              state,
              result: { status: 'already_decided' } as const,
            };
          }
          if (accepted.includes(state.card.fullScopeNeedId ?? '')) {
            state.card.fullScopeNeedId = null;
            state.card.fullScopeAskingEpoch = null;
          }
          reviseLivingCard(state, this.capacity, now);
          return {
            state,
            result: { status: 'accepted', needIds: accepted } as const,
          };
        },
      },
    );
  }

  async decideCardAction(
    input: JobPermissionCardActionInput,
  ): Promise<JobPermissionCardDecisionOutcome> {
    const action = parseJobPermissionCardAction(input.token);
    if (!action) return { status: 'stale' };
    const state = await this.repository.findJobPermissionStateByCallbackKey({
      callbackKey: action.callbackKey,
    });
    if (!state) return { status: 'stale' };
    if (action.decision === 'next') {
      return this.showNextPage({
        appId: state.card.appId,
        jobId: state.card.jobId,
        sourceAgentFolder: state.card.sourceAgentFolder,
        actorRef: input.actor.actorRef,
        actorContext: {
          conversationJid: input.actor.conversationJid,
          providerAccountId: input.actor.providerAccountId,
          threadId: input.actor.threadId,
        },
        revision: action.revision,
        providerMessageId: input.providerMessageId,
      });
    }
    const target = cardActionTarget(state, action);
    if (!target) return { status: 'stale' };
    if (action.decision === 'show') {
      return this.showFullScope({
        appId: state.card.appId,
        jobId: state.card.jobId,
        sourceAgentFolder: state.card.sourceAgentFolder,
        actorRef: input.actor.actorRef,
        actorContext: {
          conversationJid: input.actor.conversationJid,
          providerAccountId: input.actor.providerAccountId,
          threadId: input.actor.threadId,
        },
        revision: action.revision,
        needId: target.needId,
        askingEpoch: target.askingEpoch,
        providerMessageId: input.providerMessageId,
      });
    }
    if (action.decision === 'reconsider') {
      return this.reconsider({
        appId: state.card.appId,
        jobId: state.card.jobId,
        sourceAgentFolder: state.card.sourceAgentFolder,
        actorRef: input.actor.actorRef,
        actorContext: {
          conversationJid: input.actor.conversationJid,
          providerAccountId: input.actor.providerAccountId,
          threadId: input.actor.threadId,
        },
        revision: action.revision,
        needId: target.needId,
        askingEpoch: target.askingEpoch,
        providerMessageId: input.providerMessageId,
      });
    }
    return this.decideCard({
      appId: state.card.appId,
      jobId: state.card.jobId,
      sourceAgentFolder: state.card.sourceAgentFolder,
      actorRef: input.actor.actorRef,
      actorContext: {
        conversationJid: input.actor.conversationJid,
        providerAccountId: input.actor.providerAccountId,
        threadId: input.actor.threadId,
      },
      revision: action.revision,
      decision: action.decision,
      needId: target.needId,
      askingEpoch: target.askingEpoch,
      batch: action.rowIndex === null,
      reason: input.reason,
      providerMessageId: input.providerMessageId,
    });
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
    if (
      !(await this.effects.authorizeActor({
        appId: input.appId,
        jobId: input.jobId,
        actorRef: input.actorRef,
        ...input.actorContext,
      }))
    ) {
      return { status: 'unauthorized' };
    }
    const now = this.clock.now();
    return this.repository.mutateJobPermissionState<JobPermissionCardDecisionOutcome>(
      {
        appId: input.appId,
        jobId: input.jobId,
        initialCard: initialCard(input, now),
        mutate: (state) => {
          const revision = state.card.revisions.find(
            (candidate) => candidate.revision === input.revision,
          );
          if (revision) {
            recordConfirmedCardCallback(
              state,
              revision,
              input.providerMessageId,
              now,
            );
          }
          const row = revision?.rows.find(
            (candidate) =>
              candidate.needId === input.needId &&
              candidate.askingEpoch === input.askingEpoch,
          );
          const need = state.needs.find(
            (candidate) =>
              candidate.id === input.needId &&
              candidate.askingEpoch === input.askingEpoch,
          );
          if (!row || row.action !== 'show_scope' || !need) {
            return { state, result: { status: 'stale' } as const };
          }
          state.card.fullScopeNeedId = need.id;
          state.card.fullScopeAskingEpoch = need.askingEpoch;
          reviseLivingCard(state, this.capacity, now);
          return {
            state,
            result: { status: 'accepted', needIds: [need.id] } as const,
          };
        },
      },
    );
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
    if (
      !(await this.effects.authorizeActor({
        appId: input.appId,
        jobId: input.jobId,
        actorRef: input.actorRef,
        ...input.actorContext,
      }))
    ) {
      return { status: 'unauthorized' };
    }
    const now = this.clock.now();
    return this.repository.mutateJobPermissionState<JobPermissionCardDecisionOutcome>(
      {
        appId: input.appId,
        jobId: input.jobId,
        initialCard: initialCard(input, now),
        mutate: (state) => {
          const revision = state.card.revisions.find(
            (candidate) => candidate.revision === input.revision,
          );
          if (
            !revision ||
            state.card.revision !== revision.revision ||
            revision.hiddenRowCount === 0
          ) {
            return { state, result: { status: 'stale' } as const };
          }
          recordConfirmedCardCallback(
            state,
            revision,
            input.providerMessageId,
            now,
          );
          const rowCount = livingCardNeeds(state).length;
          const nextOffset = revision.pageStart + revision.rows.length;
          state.card.pageOffset = nextOffset < rowCount ? nextOffset : 0;
          reviseLivingCard(state, this.capacity, now);
          return {
            state,
            result: {
              status: 'accepted',
              needIds: state.card.revisions
                .at(-1)!
                .rows.map((row) => row.needId),
            } as const,
          };
        },
      },
    );
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
    if (
      !(await this.effects.authorizeActor({
        appId: input.appId,
        jobId: input.jobId,
        actorRef: input.actorRef,
        ...input.actorContext,
      }))
    ) {
      return { status: 'unauthorized' };
    }
    const now = this.clock.now();
    return this.repository.mutateJobPermissionState<JobPermissionCardDecisionOutcome>(
      {
        appId: input.appId,
        jobId: input.jobId,
        initialCard: initialCard(input, now),
        mutate: (state) => {
          const revision = state.card.revisions.find(
            (candidate) => candidate.revision === input.revision,
          );
          if (revision) {
            recordConfirmedCardCallback(
              state,
              revision,
              input.providerMessageId,
              now,
            );
          }
          const rendered = revision?.rows.some(
            (row) =>
              row.needId === input.needId &&
              row.askingEpoch === input.askingEpoch &&
              row.action === 'reconsider',
          );
          const need = state.needs.find(
            (candidate) => candidate.id === input.needId,
          );
          if (
            !rendered ||
            !need ||
            need.state !== 'denied' ||
            need.askingEpoch !== input.askingEpoch
          ) {
            return { state, result: { status: 'stale' } as const };
          }
          removePendingRerunBarriersForNeed(
            state.card,
            need.id,
            need.askingEpoch,
          );
          need.askingEpoch += 1;
          need.state = 'asking';
          need.approvedGrantAtoms = null;
          need.policyChangedReason = null;
          need.waitStartedAt = null;
          need.decidedAt = null;
          need.decidedBy = null;
          need.denialReason = null;
          need.policyChangedReason = null;
          need.grantAppliedAt = null;
          need.state = 'handed_off';
          state.card.fullScopeNeedId = null;
          state.card.fullScopeAskingEpoch = null;
          for (const waiter of need.waiters) {
            waiter.responseId = jobPermissionResponseId(
              need.id,
              need.askingEpoch,
              waiter.id,
            );
            waiter.state = 'handoff';
            waiter.slotReleased = false;
            waiter.responseDeliveredAt = null;
            waiter.updatedAt = now;
          }
          need.updatedAt = now;
          reviseLivingCard(state, this.capacity, now);
          return {
            state,
            result: { status: 'accepted', needIds: [need.id] } as const,
          };
        },
      },
    );
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
    const existing = await this.repository.getJobPermissionState({
      appId: input.appId,
      jobId: input.jobId,
    });
    if (!existing) return 0;
    const now = this.clock.now();
    const hostBootId = input.hostBootId ?? this.clock.hostBootId();
    const monotonicMs = input.monotonicMs ?? this.clock.monotonicMs();
    return this.repository.mutateJobPermissionState({
      appId: input.appId,
      jobId: input.jobId,
      initialCard: initialCard(input, now),
      mutate: (state) => {
        const budget = budgetForRun(state.card, input.runId);
        advancePendingBudget(
          budget,
          hostBootId,
          monotonicMs,
          input.maxDeltaMs ?? MAX_WAIT_MS,
        );
        state.card.updatedAt = now;
        return { state, result: budget.accumulatedMs };
      },
    });
  }

  async pendingLeaseExtensionMs(input: {
    appId: string;
    jobId: string;
    runId: string;
    hostBootId?: string;
    monotonicMs?: number;
    maxDeltaMs?: number;
  }): Promise<number> {
    const state = await this.repository.getJobPermissionState(input);
    const budget = state?.card.pendingBudgets.find(
      (candidate) => candidate.runId === input.runId,
    );
    if (!budget) return 0;
    const copy = { ...budget };
    advancePendingBudget(
      copy,
      input.hostBootId ?? this.clock.hostBootId(),
      input.monotonicMs ?? this.clock.monotonicMs(),
      input.maxDeltaMs ?? MAX_WAIT_MS,
    );
    return Math.min(MAX_WAIT_MS, copy.accumulatedMs);
  }

  async reconcile(limit = 100): Promise<number> {
    const candidates =
      await this.repository.listJobPermissionNeedsForReconciliation({ limit });
    let progressed = 0;
    for (const candidate of candidates) {
      const deliveryProgressed = await this.reconcileCardDelivery(candidate);
      if (deliveryProgressed) progressed += 1;
      const current = deliveryProgressed
        ? await this.currentNeed(candidate)
        : candidate;
      if (current && (await this.reconcileNeed(current))) progressed += 1;
    }
    return progressed;
  }

  private async reconcileCardDelivery(candidate: JobPermissionNeedRecord) {
    const state = await this.repository.getJobPermissionState({
      appId: candidate.appId,
      jobId: candidate.jobId,
    });
    const revision = state?.card.revisions
      .filter((entry) =>
        entry.rows.some(
          (row) =>
            row.needId === candidate.id &&
            row.askingEpoch === candidate.askingEpoch,
        ),
      )
      .at(-1);
    if (!revision || candidate.waitStartedAt) return false;
    const outcome = await this.repository.getJobPermissionCardDeliveryOutcome({
      appId: candidate.appId,
      deliveryId: revision.deliveryId,
    });
    if (!outcome || outcome.status === 'pending') return false;
    if (outcome.status === 'delivered') {
      return this.confirmCardDelivery({
        appId: candidate.appId,
        jobId: candidate.jobId,
        sourceAgentFolder: candidate.sourceAgentFolder,
        revision: revision.revision,
        provider: outcome.provider ?? 'unknown',
        providerMessageId: outcome.providerMessageId,
        deliveredAt: outcome.deliveredAt,
      });
    }
    const now = this.clock.now();
    return this.mutateExisting(candidate, (cardState, need) => {
      if (need.state !== 'asking' || need.waitStartedAt) return false;
      need.denialReason = outcome.reason;
      need.state = 'handoff_pending';
      need.updatedAt = now;
      reviseLivingCard(cardState, this.capacity, now);
      return true;
    });
  }

  private async reconcileNeed(candidate: JobPermissionNeedRecord) {
    let progressed = false;
    if (candidate.state === 'asking') {
      progressed = (await this.releaseWaitingSlots(candidate)) || progressed;
      progressed = (await this.handoffDeadWaiters(candidate)) || progressed;
    } else if (candidate.state === 'approved_pending_apply') {
      progressed = (await this.applyApprovedNeed(candidate)) || progressed;
    } else if (candidate.state === 'denied_pending_delivery') {
      progressed = (await this.deliverDeniedNeed(candidate)) || progressed;
    } else if (candidate.state === 'handoff_pending') {
      progressed = (await this.finishHandoff(candidate)) || progressed;
    }
    return progressed;
  }

  private async releaseWaitingSlots(candidate: JobPermissionNeedRecord) {
    let progressed = false;
    for (const waiter of candidate.waiters.filter(
      (entry) => entry.state === 'release_pending',
    )) {
      progressed =
        (await this.releaseWaitingSlot(candidate, waiter)) || progressed;
    }
    return progressed;
  }

  private async releaseWaitingSlot(
    candidate: JobPermissionNeedRecord,
    waiter: JobPermissionWaiter,
  ): Promise<boolean> {
    const released = await this.effects.releaseSlot({
      runId: waiter.runId,
      waiterId: waiter.id,
      leaseToken: waiter.runLeaseToken,
      fencingVersion: waiter.runLeaseFencingVersion,
    });
    if (!released) return false;
    const now = this.clock.now();
    return this.mutateExisting(candidate, (state, need) => {
      const current = need.waiters.find((entry) => entry.id === waiter.id);
      if (!current || current.state !== 'release_pending') return false;
      current.state = 'waiting';
      current.slotReleased = true;
      current.updatedAt = now;
      openPendingBudget(
        budgetForRun(state.card, current.runId),
        this.clock.hostBootId(),
        this.clock.monotonicMs(),
      );
      need.updatedAt = now;
      state.card.updatedAt = now;
      return true;
    });
  }

  private async handoffDeadWaiters(candidate: JobPermissionNeedRecord) {
    if (!candidate.waitStartedAt) return false;
    const expired =
      Date.parse(this.clock.now()) - Date.parse(candidate.waitStartedAt) >=
      MAX_WAIT_MS;
    const deadIds: string[] = [];
    const expiredLiveIds: string[] = [];
    for (const waiter of candidate.waiters.filter((entry) =>
      ['waiting', 'release_pending'].includes(entry.state),
    )) {
      const alive = await this.effects.isRunAlive({
        runId: waiter.runId,
        leaseToken: waiter.runLeaseToken,
        fencingVersion: waiter.runLeaseFencingVersion,
      });
      if (!alive) {
        deadIds.push(waiter.id);
      } else if (expired) {
        expiredLiveIds.push(waiter.id);
      }
    }
    if (deadIds.length === 0 && expiredLiveIds.length === 0) return false;
    const now = this.clock.now();
    return this.mutateExisting(candidate, (state, need) => {
      if (
        need.state !== 'asking' ||
        need.askingEpoch !== candidate.askingEpoch
      ) {
        return false;
      }
      const transitioningIds = new Set([...deadIds, ...expiredLiveIds]);
      const hasLive = need.waiters.some(
        (waiter) =>
          ['awaiting_card_delivery', 'release_pending', 'waiting'].includes(
            waiter.state,
          ) && !transitioningIds.has(waiter.id),
      );
      for (const waiter of need.waiters) {
        if (!deadIds.includes(waiter.id)) continue;
        if (waiter.state === 'waiting' && waiter.slotReleased) {
          closePendingBudget(
            budgetForRun(state.card, waiter.runId),
            this.clock.hostBootId(),
            this.clock.monotonicMs(),
          );
        }
        waiter.state = hasLive ? 'retired' : 'handoff';
        waiter.updatedAt = now;
      }
      need.state = hasLive ? 'asking' : 'handoff_pending';
      need.updatedAt = now;
      if (hasLive) reviseLivingCard(state, this.capacity, now);
      return true;
    });
  }

  private async finishHandoff(candidate: JobPermissionNeedRecord) {
    await this.deliverNeedResponses(candidate, {
      kind: 'setup_required',
      reason:
        candidate.denialReason ??
        'The approval question moved to a durable card; approve it to run the job again.',
    });
    const now = this.clock.now();
    return this.mutateExisting(candidate, (state, need) => {
      if (
        need.state !== 'handoff_pending' ||
        !need.waiters.every((waiter) =>
          ['delivered', 'retired', 'handoff'].includes(waiter.state),
        )
      ) {
        return false;
      }
      need.state = need.approvedGrantAtoms?.length
        ? 'approved_pending_apply'
        : need.decidedBy
          ? 'denied_pending_delivery'
          : 'handed_off';
      need.updatedAt = now;
      reviseLivingCard(state, this.capacity, now);
      return true;
    });
  }

  private async applyApprovedNeed(candidate: JobPermissionNeedRecord) {
    const displayed = candidate.approvedGrantAtoms ?? [];
    if (displayed.length === 0) return false;
    if (candidate.policyChangedReason) {
      await this.deliverNeedResponses(candidate, {
        kind: 'policy_changed',
        reason: candidate.policyChangedReason,
      });
      const now = this.clock.now();
      return this.mutateExisting(candidate, (state, need) => {
        if (
          need.state !== 'approved_pending_apply' ||
          !need.policyChangedReason ||
          !need.waiters.every((waiter) =>
            ['delivered', 'retired', 'handoff'].includes(waiter.state),
          )
        ) {
          return false;
        }
        need.state = 'cancelled';
        need.updatedAt = now;
        reviseLivingCard(state, this.capacity, now);
        return true;
      });
    }
    if (!candidate.grantAppliedAt) {
      const revalidated = await this.effects.revalidate({
        appId: candidate.appId,
        jobId: candidate.jobId,
        needId: candidate.id,
        askingEpoch: candidate.askingEpoch,
        renderedGrantAtoms: displayed,
      });
      const grantAtoms = canonicalAtoms(revalidated.grantAtoms ?? []);
      if (
        revalidated.kind !== 'approved' ||
        grantAtoms.some((atom) => !displayed.includes(atom))
      ) {
        const now = this.clock.now();
        await this.mutateExisting(candidate, (state, need) => {
          if (need.state !== 'approved_pending_apply') return false;
          if (revalidated.kind === 'reask' && grantAtoms.length > 0) {
            removePendingRerunBarriersForNeed(
              state.card,
              need.id,
              need.askingEpoch,
            );
            need.askingEpoch += 1;
            need.state = 'asking';
            need.renderedGrantAtoms = grantAtoms;
            need.displayLabel = revalidated.displayLabel ?? need.displayLabel;
            need.approvedGrantAtoms = null;
            need.waitStartedAt = null;
            need.decidedAt = null;
            need.decidedBy = null;
            for (const waiter of need.waiters) {
              if (waiter.state === 'waiting' && waiter.slotReleased) {
                closePendingBudget(
                  budgetForRun(state.card, waiter.runId),
                  this.clock.hostBootId(),
                  this.clock.monotonicMs(),
                );
              }
              waiter.responseId = jobPermissionResponseId(
                need.id,
                need.askingEpoch,
                waiter.id,
              );
              waiter.state = 'awaiting_card_delivery';
              waiter.updatedAt = now;
            }
          } else {
            removePendingRerunBarriersForNeed(
              state.card,
              need.id,
              need.askingEpoch,
            );
            need.policyChangedReason =
              revalidated.reason ??
              'Permission policy changed before the grant was applied.';
          }
          need.updatedAt = now;
          reviseLivingCard(state, this.capacity, now);
          return true;
        });
        return true;
      }
      await this.effects.persistGrant({
        idempotencyKey: `job-permission-grant:${candidate.id}:${candidate.askingEpoch}`,
        appId: candidate.appId,
        jobId: candidate.jobId,
        needId: candidate.id,
        askingEpoch: candidate.askingEpoch,
        grantAtoms,
        decidedBy: candidate.decidedBy ?? 'unknown',
      });
      const now = this.clock.now();
      await this.mutateExisting(candidate, (_state, need) => {
        if (need.state !== 'approved_pending_apply') return false;
        need.grantAppliedAt ??= now;
        need.approvedGrantAtoms = grantAtoms;
        need.updatedAt = now;
        return true;
      });
    }

    const current = await this.currentNeed(candidate);
    if (!current || current.state !== 'approved_pending_apply') return true;
    await this.deliverNeedResponses(current, {
      kind: 'approved',
      grantAtoms: current.approvedGrantAtoms ?? displayed,
    });
    await this.reconcileRerunBarriers(current);
    const now = this.clock.now();
    await this.mutateExisting(current, (state, need) => {
      const waitersSettled = need.waiters.every((waiter) =>
        ['delivered', 'retired', 'handoff'].includes(waiter.state),
      );
      const rerunsSettled = state.card.rerunBarriers
        .filter((barrier) =>
          barrier.requiredNeeds.some(
            (required) =>
              required.needId === need.id &&
              required.askingEpoch === need.askingEpoch,
          ),
        )
        .every((barrier) => barrier.enqueuedAt);
      if (!waitersSettled || !rerunsSettled) return false;
      need.state = 'applied';
      need.updatedAt = now;
      reviseLivingCard(state, this.capacity, now);
      return true;
    });
    return true;
  }

  private async reconcileRerunBarriers(
    candidate: JobPermissionNeedRecord,
  ): Promise<void> {
    const state = await this.repository.getJobPermissionState({
      appId: candidate.appId,
      jobId: candidate.jobId,
    });
    if (!state) return;
    for (const barrier of state.card.rerunBarriers.filter(
      (entry) => !entry.enqueuedAt,
    )) {
      const ready = barrier.requiredNeeds.every((required) => {
        const need = state.needs.find(
          (entry) =>
            entry.id === required.needId &&
            entry.askingEpoch === required.askingEpoch,
        );
        return Boolean(
          need?.grantAppliedAt &&
          need.waiters.every((waiter) =>
            ['delivered', 'retired', 'handoff'].includes(waiter.state),
          ),
        );
      });
      if (!ready) continue;
      await this.effects.enqueueRunAgain({
        idempotencyKey: `job-permission-rerun:${candidate.appId}:${candidate.jobId}:${barrier.priorRunId}`,
        appId: candidate.appId,
        jobId: candidate.jobId,
        priorRunId: barrier.priorRunId,
      });
      const now = this.clock.now();
      await this.repository.mutateJobPermissionState({
        appId: candidate.appId,
        jobId: candidate.jobId,
        initialCard: initialCard(candidate, now),
        mutate: (current) => {
          const pending = current.card.rerunBarriers.find(
            (entry) => entry.priorRunId === barrier.priorRunId,
          );
          if (pending) pending.enqueuedAt ??= now;
          current.card.updatedAt = now;
          return { state: current, result: undefined };
        },
      });
    }
  }

  private async deliverDeniedNeed(candidate: JobPermissionNeedRecord) {
    await this.deliverNeedResponses(candidate, {
      kind: 'denied',
      reason: candidate.denialReason ?? 'Permission denied for this job.',
    });
    const now = this.clock.now();
    await this.mutateExisting(candidate, (state, need) => {
      if (
        need.state !== 'denied_pending_delivery' ||
        !need.waiters.every((waiter) =>
          ['delivered', 'retired', 'handoff'].includes(waiter.state),
        )
      ) {
        return false;
      }
      need.state = 'denied';
      need.updatedAt = now;
      reviseLivingCard(state, this.capacity, now);
      return true;
    });
    return true;
  }

  private async deliverNeedResponses(
    candidate: JobPermissionNeedRecord,
    response:
      | { kind: 'approved'; grantAtoms: readonly string[] }
      | { kind: 'denied'; reason: string }
      | { kind: 'policy_changed'; reason: string }
      | { kind: 'setup_required'; reason: string },
  ) {
    for (const candidateWaiter of candidate.waiters.filter((entry) =>
      [
        'awaiting_card_delivery',
        'release_pending',
        'waiting',
        'response_pending',
      ].includes(entry.state),
    )) {
      let waiter = candidateWaiter;
      if (waiter.state === 'release_pending') {
        await this.releaseWaitingSlot(candidate, waiter);
        const current = await this.currentNeed(candidate);
        const released = current?.waiters.find(
          (entry) => entry.id === waiter.id,
        );
        if (!released || released.state !== 'waiting') continue;
        waiter = released;
      }
      const alive = await this.effects.isRunAlive({
        runId: waiter.runId,
        leaseToken: waiter.runLeaseToken,
        fencingVersion: waiter.runLeaseFencingVersion,
      });
      if (!alive) {
        const now = this.clock.now();
        await this.mutateExisting(candidate, (state, need) => {
          const current = need.waiters.find((entry) => entry.id === waiter.id);
          if (!current || ['delivered', 'retired'].includes(current.state)) {
            return false;
          }
          if (current.state === 'waiting' && current.slotReleased) {
            closePendingBudget(
              budgetForRun(state.card, current.runId),
              this.clock.hostBootId(),
              this.clock.monotonicMs(),
            );
          }
          current.state = 'retired';
          current.updatedAt = now;
          need.updatedAt = now;
          return true;
        });
        continue;
      }
      if (waiter.slotReleased) {
        const acquired = await this.effects.acquireSlot({
          runId: waiter.runId,
          waiterId: waiter.id,
          leaseToken: waiter.runLeaseToken,
          fencingVersion: waiter.runLeaseFencingVersion,
        });
        if (!acquired) continue;
      }
      const pending = await this.markResponsePending(candidate, waiter.id);
      if (!pending) continue;
      await this.effects.deliverWaiterResponse({
        responseId: waiter.responseId,
        appId: candidate.appId,
        sourceAgentFolder: candidate.sourceAgentFolder,
        waiter,
        response,
      });
      const now = this.clock.now();
      await this.mutateExisting(candidate, (_state, need) => {
        const current = need.waiters.find((entry) => entry.id === waiter.id);
        if (!current || current.state !== 'response_pending') return false;
        current.state =
          response.kind === 'setup_required' ? 'handoff' : 'delivered';
        current.responseDeliveredAt = now;
        current.updatedAt = now;
        need.updatedAt = now;
        return true;
      });
    }
  }

  private markResponsePending(
    candidate: JobPermissionNeedRecord,
    waiterId: string,
  ) {
    const now = this.clock.now();
    return this.mutateExisting(candidate, (state, need) => {
      const waiter = need.waiters.find((entry) => entry.id === waiterId);
      if (!waiter || ['delivered', 'retired'].includes(waiter.state))
        return false;
      if (waiter.state === 'waiting' && waiter.slotReleased) {
        closePendingBudget(
          budgetForRun(state.card, waiter.runId),
          this.clock.hostBootId(),
          this.clock.monotonicMs(),
        );
      }
      waiter.state = 'response_pending';
      waiter.slotReleased = false;
      waiter.updatedAt = now;
      need.updatedAt = now;
      return true;
    });
  }

  private async currentNeed(candidate: JobPermissionNeedRecord) {
    return (
      await this.repository.getJobPermissionState({
        appId: candidate.appId,
        jobId: candidate.jobId,
      })
    )?.needs.find((need) => need.id === candidate.id);
  }

  private mutateExisting(
    candidate: JobPermissionNeedRecord,
    mutate: (
      state: JobPermissionDurabilityState,
      need: JobPermissionNeedRecord,
    ) => boolean,
  ) {
    return this.repository.mutateJobPermissionState({
      appId: candidate.appId,
      jobId: candidate.jobId,
      initialCard: initialCard(candidate, this.clock.now()),
      mutate: (state) => {
        const need = state.needs.find((entry) => entry.id === candidate.id);
        if (!need) return { state, result: false };
        return { state, result: mutate(state, need) };
      },
    });
  }
}

export function canonicalJobPermissionNeedIdentity(
  grantAtoms: readonly string[],
): string {
  const atoms = canonicalAtoms(grantAtoms);
  if (atoms.length === 0) throw new Error('Canonical need scope is empty.');
  return JSON.stringify(atoms);
}

export function jobPermissionNeedId(
  appId: string,
  jobId: string,
  canonicalIdentity: string,
): string {
  return `job-permission-need:${sha256Hex(
    JSON.stringify([appId, jobId, canonicalIdentity]),
  )}`;
}

export function jobPermissionCardId(appId: string, jobId: string): string {
  return `job-permission-card:${sha256Hex(JSON.stringify([appId, jobId]))}`;
}

export function jobPermissionCardCallbackKey(
  appId: string,
  jobId: string,
): string {
  return sha256Hex(JSON.stringify([appId, jobId, 'job-permission-card'])).slice(
    0,
    24,
  );
}

export function jobPermissionRecordExpiresAt(): string {
  return NEVER_EXPIRES_AT;
}

function jobPermissionResponseId(
  needId: string,
  askingEpoch: number,
  waiterId: string,
) {
  return `job-permission-response:${sha256Hex(
    JSON.stringify([needId, askingEpoch, waiterId]),
  )}`;
}

function canonicalAtoms(atoms: readonly string[]): string[] {
  return [...new Set(atoms.map((atom) => atom.trim()).filter(Boolean))];
}

function initialCard(
  input: {
    appId: string;
    jobId: string;
    sourceAgentFolder?: string;
    conversationId?: string;
    threadId?: string | null;
    agentId?: string | null;
  },
  now: string,
): JobPermissionCardRecord {
  return {
    schemaVersion: 1,
    recordType: 'job_permission_card',
    id: jobPermissionCardId(input.appId, input.jobId),
    appId: input.appId,
    jobId: input.jobId,
    callbackKey: jobPermissionCardCallbackKey(input.appId, input.jobId),
    sourceAgentFolder: input.sourceAgentFolder ?? '',
    conversationId: input.conversationId ?? '',
    threadId: input.threadId ?? null,
    agentId: input.agentId ?? null,
    revision: 0,
    currentProviderMessageId: null,
    currentProvider: null,
    currentProviderRevision: 0,
    pageOffset: 0,
    fullScopeNeedId: null,
    fullScopeAskingEpoch: null,
    revisions: [],
    pendingBudgets: [],
    rerunBarriers: [],
    createdAt: now,
    updatedAt: now,
  };
}

function cardActionTarget(
  state: JobPermissionDurabilityState,
  action: ParsedJobPermissionCardAction,
): JobPermissionCardRowSnapshot | null {
  const revision = state.card.revisions.find(
    (candidate) => candidate.revision === action.revision,
  );
  if (!revision) return null;
  if (action.rowIndex === null) {
    return (
      revision.rows.find((row) => revision.batchNeedIds.includes(row.needId)) ??
      null
    );
  }
  return revision.rows[action.rowIndex] ?? null;
}

function recordConfirmedCardCallback(
  state: JobPermissionDurabilityState,
  revision: JobPermissionCardRevision,
  providerMessageId: string | undefined,
  now: string,
): void {
  const messageId = providerMessageId?.trim();
  if (!messageId) return;
  if (revision.revision >= state.card.currentProviderRevision) {
    state.card.currentProviderMessageId = messageId;
    state.card.currentProviderRevision = revision.revision;
  }
  for (const row of revision.rows) {
    const need = state.needs.find(
      (candidate) =>
        candidate.id === row.needId &&
        candidate.askingEpoch === row.askingEpoch &&
        candidate.state === 'asking',
    );
    if (!need) continue;
    need.waitStartedAt ??= now;
    for (const waiter of need.waiters) {
      if (waiter.state === 'awaiting_card_delivery') {
        waiter.state = 'release_pending';
        waiter.updatedAt = now;
      }
    }
    need.updatedAt = now;
  }
  state.card.updatedAt = now;
}

function reviseLivingCard(
  state: JobPermissionDurabilityState,
  capacity: JobPermissionCardCapacity,
  now: string,
): void {
  const rows = livingCardNeeds(state).map(
    (need): JobPermissionCardRowSnapshot => {
      const scopeFullyVisible =
        need.renderedGrantAtoms.length <= capacity.maxGrantAtomsPerRow ||
        (state.card.fullScopeNeedId === need.id &&
          state.card.fullScopeAskingEpoch === need.askingEpoch);
      const ordinaryAction =
        need.state === 'denied'
          ? 'reconsider'
          : need.state === 'handed_off'
            ? 'approve_and_run_again'
            : 'allow_and_continue';
      return {
        needId: need.id,
        askingEpoch: need.askingEpoch,
        displayLabel: need.displayLabel,
        renderedGrantAtoms: [...need.renderedGrantAtoms],
        visibleGrantAtoms: scopeFullyVisible
          ? [...need.renderedGrantAtoms]
          : need.renderedGrantAtoms.slice(0, capacity.maxGrantAtomsPerRow),
        scopeFullyVisible,
        actionEnabled: true,
        denyEnabled: need.state !== 'denied',
        action: scopeFullyVisible ? ordinaryAction : 'show_scope',
      };
    },
  );
  if (rows.length === 0) {
    state.card.pageOffset = 0;
  } else if (state.card.pageOffset >= rows.length) {
    state.card.pageOffset =
      Math.floor((rows.length - 1) / capacity.maxRows) * capacity.maxRows;
  }
  const pageStart = state.card.pageOffset;
  const visible = rows.slice(pageStart, pageStart + capacity.maxRows);
  const hiddenRowCount = Math.max(0, rows.length - visible.length);
  const last = state.card.revisions.at(-1);
  if (
    last &&
    JSON.stringify(last.rows) === JSON.stringify(visible) &&
    last.pageStart === pageStart &&
    last.hiddenRowCount === hiddenRowCount
  ) {
    return;
  }
  const revision = state.card.revision + 1;
  const operation: JobPermissionCardRevision['operation'] =
    visible.length === 0
      ? 'retire'
      : state.card.currentProviderMessageId
        ? 'edit'
        : state.card.revisions.length > 0
          ? 'replace'
          : 'send';
  const deliveryId = `job-permission-card-delivery:${sha256Hex(
    JSON.stringify([state.card.id, revision]),
  )}`;
  state.card.revision = revision;
  state.card.revisions.push({
    revision,
    operation,
    deliveryId,
    deliveryItemId: `${deliveryId}:item`,
    rows: visible,
    batchNeedIds: visible
      .filter((row) => row.action === 'allow_and_continue' && row.actionEnabled)
      .map((row) => row.needId),
    pageStart,
    hiddenRowCount,
    createdAt: now,
  });
  state.card.updatedAt = now;
}

function livingCardNeeds(
  state: JobPermissionDurabilityState,
): JobPermissionNeedRecord[] {
  return state.needs
    .filter((need) => ['asking', 'handed_off', 'denied'].includes(need.state))
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );
}

function recordRerunConsent(
  state: JobPermissionDurabilityState,
  need: JobPermissionNeedRecord,
  priorRunId: string,
  requestedBy: string,
  now: string,
): void {
  let barrier = state.card.rerunBarriers.find(
    (entry) => entry.priorRunId === priorRunId,
  );
  if (!barrier) {
    barrier = {
      priorRunId,
      requiredNeeds: [],
      requestedAt: now,
      requestedBy,
      enqueuedAt: null,
    };
    state.card.rerunBarriers.push(barrier);
  }
  const requiredNeeds = state.needs
    .filter(
      (candidate) =>
        !['applied', 'cancelled'].includes(candidate.state) &&
        candidate.waiters.some((waiter) => waiter.runId === priorRunId),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (!requiredNeeds.some((candidate) => candidate.id === need.id)) {
    requiredNeeds.push(need);
  }
  for (const requiredNeed of requiredNeeds) {
    if (
      barrier.requiredNeeds.some(
        (required) =>
          required.needId === requiredNeed.id &&
          required.askingEpoch === requiredNeed.askingEpoch,
      )
    ) {
      continue;
    }
    barrier.requiredNeeds.push({
      needId: requiredNeed.id,
      askingEpoch: requiredNeed.askingEpoch,
    });
  }
}

function removePendingRerunBarriersForNeed(
  card: JobPermissionCardRecord,
  needId: string,
  askingEpoch: number,
): void {
  card.rerunBarriers = card.rerunBarriers.filter(
    (barrier) =>
      barrier.enqueuedAt ||
      !barrier.requiredNeeds.some(
        (required) =>
          required.needId === needId && required.askingEpoch === askingEpoch,
      ),
  );
}

function budgetForRun(
  card: JobPermissionCardRecord,
  runId: string,
): JobPermissionPendingBudget {
  let budget = card.pendingBudgets.find(
    (candidate) => candidate.runId === runId,
  );
  if (!budget) {
    budget = {
      runId,
      openCount: 0,
      accumulatedMs: 0,
      hostBootId: null,
      lastMonotonicMs: null,
    };
    card.pendingBudgets.push(budget);
  }
  return budget;
}

function openPendingBudget(
  budget: JobPermissionPendingBudget,
  hostBootId: string,
  monotonicMs: number,
) {
  advancePendingBudget(budget, hostBootId, monotonicMs, MAX_WAIT_MS);
  budget.openCount += 1;
}

function closePendingBudget(
  budget: JobPermissionPendingBudget,
  hostBootId: string,
  monotonicMs: number,
) {
  advancePendingBudget(budget, hostBootId, monotonicMs, MAX_WAIT_MS);
  budget.openCount = Math.max(0, budget.openCount - 1);
}

export function advancePendingBudget(
  budget: JobPermissionPendingBudget,
  hostBootId: string,
  monotonicMs: number,
  maxDeltaMs: number,
): void {
  if (
    budget.hostBootId === hostBootId &&
    budget.lastMonotonicMs !== null &&
    monotonicMs < budget.lastMonotonicMs
  ) {
    return;
  }
  if (
    budget.openCount > 0 &&
    budget.hostBootId === hostBootId &&
    budget.lastMonotonicMs !== null &&
    monotonicMs >= budget.lastMonotonicMs
  ) {
    budget.accumulatedMs = Math.min(
      MAX_WAIT_MS,
      budget.accumulatedMs +
        Math.min(Math.max(0, maxDeltaMs), monotonicMs - budget.lastMonotonicMs),
    );
  }
  budget.hostBootId = hostBootId;
  budget.lastMonotonicMs = monotonicMs;
}
