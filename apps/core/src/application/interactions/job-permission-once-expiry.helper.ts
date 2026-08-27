import type {
  JobPermissionDurabilityState,
  JobPermissionNeedRecord,
  JobPermissionNeedState,
  JobPermissionWaiterState,
} from '../../domain/ports/job-permission-durability.js';
import { reviseLivingCard } from './job-permission-card-projection.js';
import type { JobPermissionCardCapacity } from './job-permission-durability.js';

export function resolveOnceExpiryTransition(
  need: JobPermissionNeedRecord,
  deadWaiterIds: readonly string[],
  expiredLiveWaiterIds: readonly string[],
): {
  expires: boolean;
  hasLiveWaiter: boolean;
  waiterIds: ReadonlySet<string>;
  waiterState: JobPermissionWaiterState;
  needState: JobPermissionNeedState;
} {
  const transitioningWaiterIds = new Set([
    ...deadWaiterIds,
    ...expiredLiveWaiterIds,
  ]);
  const hasLiveWaiter = need.waiters.some(
    (waiter) =>
      ['awaiting_card_delivery', 'release_pending', 'waiting'].includes(
        waiter.state,
      ) && !transitioningWaiterIds.has(waiter.id),
  );
  const expires = (need.grant ?? 'rule') === 'once' && !hasLiveWaiter;
  return {
    expires,
    hasLiveWaiter,
    waiterIds: expires ? transitioningWaiterIds : new Set(deadWaiterIds),
    waiterState: hasLiveWaiter || expires ? 'retired' : 'handoff',
    needState: expires
      ? 'cancelled'
      : hasLiveWaiter
        ? 'asking'
        : 'handoff_pending',
  };
}

export function expireHandoff(
  state: JobPermissionDurabilityState,
  need: JobPermissionNeedRecord,
  capacity: JobPermissionCardCapacity,
  now: string,
): boolean {
  if (
    (need.grant ?? 'rule') !== 'once' ||
    !['handoff_pending', 'handed_off'].includes(need.state)
  ) {
    return false;
  }
  need.state = 'cancelled';
  need.expiredAt = now;
  need.updatedAt = now;
  reviseLivingCard(state, capacity, now);
  return true;
}
