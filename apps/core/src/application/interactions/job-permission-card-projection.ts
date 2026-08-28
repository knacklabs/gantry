import type {
  JobPermissionCardRecord,
  JobPermissionCardRevision,
  JobPermissionCardRowSnapshot,
  JobPermissionDurabilityState,
  JobPermissionNeedRecord,
} from '../../domain/ports/job-permission-durability.js';
import { sha256Hex } from '../../shared/stable-hash.js';
import { canonicalJson } from '../../shared/canonical-json.js';
import type { JobPermissionCardCapacity } from './job-permission-durability.js';
import {
  jobPermissionCardCallbackKey,
  jobPermissionCardId,
} from './job-permission-durability-state.js';

const CARD_REFRESH_AFTER_MS = 10 * 60 * 1000;

export function initialCard(
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
    fullScopePageOffset: 0,
    revisions: [],
    revisionDeliveries: [],
    pendingBudgets: [],
    rerunBarriers: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function recordConfirmedCardCallback(
  state: JobPermissionDurabilityState,
  revision: JobPermissionCardRevision,
  providerMessageId: string | undefined,
  now: string,
): void {
  const messageId = providerMessageId?.trim();
  if (!messageId) return;
  confirmCardRevisionInState({
    state,
    revision,
    provider: state.card.currentProvider,
    providerMessageId: messageId,
    deliveredAt: now,
    now,
  });
}

export function reviseLivingCard(
  state: JobPermissionDurabilityState,
  capacity: JobPermissionCardCapacity,
  now: string,
  options: { force?: boolean; deliveryAttempt?: number } = {},
): void {
  const livingNeeds = livingCardNeeds(state);
  const expiredNeeds = livingNeeds.filter(
    (need) => need.state === 'cancelled' && Boolean(need.expiredAt),
  );
  const retiresExpiredCard =
    livingNeeds.length > 0 && expiredNeeds.length === livingNeeds.length;
  const needs = retiresExpiredCard ? [] : livingNeeds;
  if (
    state.card.fullScopeNeedId &&
    !needs.some(
      (need) =>
        need.id === state.card.fullScopeNeedId &&
        need.askingEpoch === state.card.fullScopeAskingEpoch,
    )
  ) {
    state.card.fullScopeNeedId = null;
    state.card.fullScopeAskingEpoch = null;
    state.card.fullScopePageOffset = 0;
  }
  const rows = needs.map((need): JobPermissionCardRowSnapshot => {
    const pagingScope =
      state.card.fullScopeNeedId === need.id &&
      state.card.fullScopeAskingEpoch === need.askingEpoch;
    const scopePageStart = pagingScope
      ? Math.min(
          state.card.fullScopePageOffset,
          Math.max(0, need.renderedGrantAtoms.length - 1),
        )
      : 0;
    const visibleGrantAtoms = need.renderedGrantAtoms.slice(
      scopePageStart,
      scopePageStart + capacity.maxGrantAtomsPerRow,
    );
    const scopeFullyVisible =
      scopePageStart + visibleGrantAtoms.length >=
      need.renderedGrantAtoms.length;
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
      grant: need.grant ?? 'rule',
      ...(need.expiredAt ? { expiredAt: need.expiredAt } : {}),
      renderedGrantAtoms: [...need.renderedGrantAtoms],
      visibleGrantAtoms,
      scopePageStart,
      scopeFullyVisible,
      actionEnabled: need.state !== 'cancelled',
      denyEnabled: !['cancelled', 'denied'].includes(need.state),
      action: scopeFullyVisible ? ordinaryAction : 'show_scope',
    };
  });
  if (rows.length === 0) {
    state.card.pageOffset = 0;
  } else if (state.card.pageOffset >= rows.length) {
    state.card.pageOffset =
      Math.floor((rows.length - 1) / capacity.maxRows) * capacity.maxRows;
  }
  const pageStart = state.card.pageOffset;
  const visible = rows.slice(pageStart, pageStart + capacity.maxRows);
  const hiddenRowCount = Math.max(0, rows.length - visible.length);
  const retireOutcome =
    visible.length === 0
      ? retiresExpiredCard
        ? ('expired' as const)
        : ('allowed' as const)
      : undefined;
  const retiredRows = retiresExpiredCard
    ? expiredNeeds.map((need) => ({ label: need.displayLabel }))
    : undefined;
  const last = state.card.revisions.at(-1);
  if (
    !options.force &&
    last &&
    // Persisted rows return from JSONB with normalized key order.
    canonicalJson(last.rows) === canonicalJson(visible) &&
    last.pageStart === pageStart &&
    last.hiddenRowCount === hiddenRowCount &&
    last.retireOutcome === retireOutcome &&
    canonicalJson(last.retiredRows ?? []) === canonicalJson(retiredRows ?? [])
  ) {
    return;
  }
  const revision = state.card.revision + 1;
  let operation: JobPermissionCardRevision['operation'] =
    visible.length === 0
      ? 'retire'
      : state.card.currentProviderMessageId
        ? 'edit'
        : state.card.revisions.length > 0
          ? 'replace'
          : 'send';
  const isNewQuestion = visible.some(
    ({ needId, askingEpoch }) =>
      !last?.representedNeeds.some(
        (need) => need.needId === needId && need.askingEpoch === askingEpoch,
      ),
  );
  const messageFirstConfirmedAt = state.card.revisionDeliveries.find(
    (entry) =>
      entry.providerMessageId === state.card.currentProviderMessageId &&
      state.card.revisions.some(
        (revision) =>
          revision.revision === entry.revision &&
          (revision.operation === 'send' || revision.operation === 'replace'),
      ),
  )?.confirmedAt;
  const replacePending = state.card.revisions.some(
    ({ operation, revision: replaceRevision }) =>
      operation === 'replace' &&
      state.card.revisionDeliveries.find(
        (entry) => entry.revision === replaceRevision,
      )?.status !== 'delivered',
  );
  const shouldReplaceStaleCard =
    operation === 'edit' &&
    isNewQuestion &&
    (!messageFirstConfirmedAt ||
      Date.parse(now) - Date.parse(messageFirstConfirmedAt) >
        CARD_REFRESH_AFTER_MS) &&
    !replacePending;
  if (shouldReplaceStaleCard) operation = 'replace';
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
    representedNeeds: rows.map((row) => ({
      needId: row.needId,
      askingEpoch: row.askingEpoch,
    })),
    batchNeedIds: visible
      .filter((row) => row.action === 'allow_and_continue' && row.actionEnabled)
      .map((row) => row.needId),
    pageStart,
    hiddenRowCount,
    deliveryAttempt: options.deliveryAttempt ?? 1,
    ...(retireOutcome ? { retireOutcome } : {}),
    ...(retiredRows ? { retiredRows } : {}),
    createdAt: now,
  });
  state.card.revisionDeliveries.push({
    revision,
    deliveryId,
    status: 'pending',
    provider: null,
    providerMessageId: null,
    confirmedAt: null,
    reason: null,
    updatedAt: now,
  });
  state.card.updatedAt = now;
}

export function confirmCardRevisionInState(input: {
  state: JobPermissionDurabilityState;
  revision: JobPermissionCardRevision;
  provider: string | null;
  providerMessageId: string;
  deliveredAt: string;
  retireDelivery?: JobPermissionCardRevision['retireDelivery'];
  now: string;
}): boolean {
  const tracking = input.state.card.revisionDeliveries.find(
    (entry) => entry.revision === input.revision.revision,
  );
  if (!tracking || tracking.deliveryId !== input.revision.deliveryId) {
    return false;
  }
  tracking.status = 'delivered';
  tracking.provider ??= input.provider;
  tracking.providerMessageId ??= input.providerMessageId;
  tracking.confirmedAt ??= input.deliveredAt;
  tracking.reason = null;
  tracking.updatedAt = input.now;
  if (
    input.retireDelivery &&
    input.revision.operation === 'retire' &&
    !input.revision.retireDelivery?.deletedAt &&
    !input.revision.retireDelivery?.receiptMessageId
  ) {
    if (input.retireDelivery.deletedAt) {
      input.revision.retireDelivery = {
        deletedAt: input.retireDelivery.deletedAt,
      };
    } else if (input.retireDelivery.receiptMessageId) {
      input.revision.retireDelivery = {
        receiptMessageId: input.retireDelivery.receiptMessageId,
      };
    }
  }
  const retiredByDelete =
    input.revision.operation === 'retire' &&
    Boolean(input.revision.retireDelivery?.deletedAt);
  if (input.revision.revision >= input.state.card.currentProviderRevision) {
    input.state.card.currentProvider = input.provider;
    input.state.card.currentProviderMessageId = retiredByDelete
      ? null
      : input.providerMessageId;
    input.state.card.currentProviderRevision = input.revision.revision;
  }
  for (const represented of input.revision.representedNeeds) {
    const need = input.state.needs.find(
      (candidate) =>
        candidate.id === represented.needId &&
        candidate.askingEpoch === represented.askingEpoch &&
        candidate.state === 'asking',
    );
    if (!need) continue;
    need.waitStartedAt ??= input.deliveredAt;
    for (const waiter of need.waiters) {
      if (waiter.state === 'awaiting_card_delivery') {
        waiter.state = 'release_pending';
        waiter.updatedAt = input.now;
      }
    }
    need.updatedAt = input.now;
  }
  input.state.card.updatedAt = input.now;
  return true;
}

export function livingCardNeeds(
  state: JobPermissionDurabilityState,
): JobPermissionNeedRecord[] {
  return state.needs
    .filter(
      (need) =>
        ['asking', 'handed_off', 'denied'].includes(need.state) ||
        (need.state === 'cancelled' && Boolean(need.expiredAt)),
    )
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );
}
