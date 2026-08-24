import type {
  JobPermissionCardDeliveryOutcome,
  JobPermissionCardRecord,
  JobPermissionCardRevision,
  JobPermissionDurabilityState,
  JobPermissionNeedRecord,
  JobPermissionWaiter,
} from '../../domain/ports/job-permission-durability.js';
import {
  initialCard,
  reviseLivingCard,
} from './job-permission-card-projection.js';
import type { JobPermissionDurabilityDependencies } from './job-permission-durability.js';
import {
  budgetForRun,
  canonicalAtoms,
  closePendingBudget,
  jobPermissionResponseId,
  MAX_JOB_PERMISSION_WAIT_MS,
  openPendingBudget,
  removePendingRerunBarriersForNeed,
} from './job-permission-durability-state.js';
import type { JobPermissionProviderActions } from './job-permission-provider-actions.js';

const MAX_AMBIGUOUS_CARD_DELIVERY_ATTEMPTS = 4;

export class JobPermissionReconciler {
  constructor(
    private readonly dependencies: JobPermissionDurabilityDependencies,
    private readonly providerActions: JobPermissionProviderActions,
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

  async reconcile(limit = 100): Promise<number> {
    const cards = await this.repository.listJobPermissionCardsForReconciliation(
      { limit },
    );
    let progressed = 0;
    for (const card of cards) {
      if (await this.reconcileCardDelivery(card)) progressed += 1;
    }
    const candidates =
      await this.repository.listJobPermissionNeedsForReconciliation({ limit });
    for (const candidate of candidates) {
      const current = await this.currentNeed(candidate);
      if (current && (await this.reconcileNeed(current))) progressed += 1;
    }
    return progressed;
  }

  private async reconcileCardDelivery(card: JobPermissionCardRecord) {
    let selected:
      | {
          revision: JobPermissionCardRevision;
          outcome: Exclude<
            JobPermissionCardDeliveryOutcome,
            { status: 'pending' }
          >;
        }
      | undefined;
    for (const tracking of card.revisionDeliveries
      .filter((entry) => ['pending', 'ambiguous'].includes(entry.status))
      .reverse()) {
      const revision = card.revisions.find(
        (entry) => entry.revision === tracking.revision,
      );
      if (!revision || revision.deliveryId !== tracking.deliveryId) continue;
      const outcome = await this.repository.getJobPermissionCardDeliveryOutcome(
        {
          appId: card.appId,
          deliveryId: revision.deliveryId,
        },
      );
      if (!outcome || outcome.status === 'pending') continue;
      selected = { revision, outcome };
      break;
    }
    if (!selected) return false;
    const { revision, outcome } = selected;
    if (outcome.status === 'delivered') {
      return this.providerActions.confirmCardDelivery({
        appId: card.appId,
        jobId: card.jobId,
        sourceAgentFolder: card.sourceAgentFolder,
        revision: revision.revision,
        provider: outcome.provider ?? 'unknown',
        providerMessageId: outcome.providerMessageId,
        deliveredAt: outcome.deliveredAt,
      });
    }
    const now = this.clock.now();
    return this.repository.mutateJobPermissionState<boolean>({
      appId: card.appId,
      jobId: card.jobId,
      initialCard: card,
      mutate: (state) => {
        const currentRevision = state.card.revisions.find(
          (entry) => entry.revision === revision.revision,
        );
        const currentTracking = state.card.revisionDeliveries.find(
          (entry) => entry.revision === revision.revision,
        );
        if (!currentRevision || !currentTracking) {
          return { state, result: false };
        }
        const changed =
          currentTracking.status !== outcome.status ||
          currentTracking.reason !== outcome.reason;
        currentTracking.status = outcome.status;
        currentTracking.reason = outcome.reason;
        currentTracking.updatedAt = now;
        if (outcome.status === 'ambiguous') {
          if (
            currentRevision.deliveryAttempt <
            MAX_AMBIGUOUS_CARD_DELIVERY_ATTEMPTS
          ) {
            reviseLivingCard(state, this.capacity, now, {
              force: true,
              deliveryAttempt: currentRevision.deliveryAttempt + 1,
            });
          }
          return {
            state,
            result:
              changed ||
              currentRevision.deliveryAttempt <
                MAX_AMBIGUOUS_CARD_DELIVERY_ATTEMPTS,
          };
        }
        for (const represented of currentRevision.representedNeeds) {
          const need = state.needs.find(
            (entry) =>
              entry.id === represented.needId &&
              entry.askingEpoch === represented.askingEpoch &&
              entry.state === 'asking' &&
              !entry.waitStartedAt,
          );
          if (!need) continue;
          need.denialReason = outcome.reason;
          need.state = 'handoff_pending';
          need.updatedAt = now;
        }
        reviseLivingCard(state, this.capacity, now);
        return { state, result: true };
      },
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
      MAX_JOB_PERMISSION_WAIT_MS;
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
            state.card.fullScopeNeedId = null;
            state.card.fullScopeAskingEpoch = null;
            state.card.fullScopePageOffset = 0;
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
