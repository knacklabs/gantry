import { parseJobPermissionCardAction } from '../../domain/job-permission-card-actions.js';
import type { JobPermissionActorContext } from '../../domain/ports/job-permission-durability.js';
import {
  confirmCardRevisionInState,
  initialCard,
  livingCardNeeds,
  recordConfirmedCardCallback,
  reviseLivingCard,
} from './job-permission-card-projection.js';
import type {
  JobPermissionCardActionInput,
  JobPermissionCardDecisionOutcome,
  JobPermissionDurabilityDependencies,
} from './job-permission-durability.js';
import {
  advancePendingBudget,
  budgetForRun,
  cardActionTarget,
  jobPermissionResponseId,
  MAX_JOB_PERMISSION_WAIT_MS,
  recordRerunConsent,
  removePendingRerunBarriersForNeed,
} from './job-permission-durability-state.js';

export class JobPermissionProviderActions {
  constructor(
    private readonly dependencies: JobPermissionDurabilityDependencies,
  ) {}

  private get repository() {
    return this.dependencies.repository;
  }

  private get effects() {
    return this.dependencies.effects;
  }

  private get clock() {
    return this.dependencies.clock;
  }

  private get capacity() {
    return this.dependencies.capacity;
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
        if (!revision) {
          return { state, result: false };
        }
        const confirmed = confirmCardRevisionInState({
          state,
          revision,
          provider: input.provider,
          providerMessageId: input.providerMessageId,
          deliveredAt,
          now,
        });
        if (!confirmed) return { state, result: false };
        reviseLivingCard(state, this.capacity, now);
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
            state.card.fullScopePageOffset = 0;
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
          const continuingScopePage =
            state.card.fullScopeNeedId === need.id &&
            state.card.fullScopeAskingEpoch === need.askingEpoch;
          state.card.fullScopeNeedId = need.id;
          state.card.fullScopeAskingEpoch = need.askingEpoch;
          state.card.fullScopePageOffset = continuingScopePage
            ? Math.min(
                state.card.fullScopePageOffset +
                  this.capacity.maxGrantAtomsPerRow,
                Math.max(0, need.renderedGrantAtoms.length - 1),
              )
            : Math.min(
                this.capacity.maxGrantAtomsPerRow,
                Math.max(0, need.renderedGrantAtoms.length - 1),
              );
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
          state.card.fullScopePageOffset = 0;
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
          input.maxDeltaMs ?? MAX_JOB_PERMISSION_WAIT_MS,
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
      input.maxDeltaMs ?? MAX_JOB_PERMISSION_WAIT_MS,
    );
    return Math.min(MAX_JOB_PERMISSION_WAIT_MS, copy.accumulatedMs);
  }
}
