import type { ProgressUpdateOptions } from '../domain/types.js';

const CONTROL_CARD_IDENTITY_RETENTION_MS = 10 * 60_000;

export type CachedStopCardIdentity = {
  routeKey: string;
  identity: string;
  cardKey: string;
  generation?: number;
  landed: boolean;
  retentionTimer?: ReturnType<typeof setTimeout>;
};

export type ProgressCardIdentityRegistry = {
  stopCardIdentityByRoute: Map<string, CachedStopCardIdentity>;
};

export type ProgressCardTarget = {
  key: string;
  dispatchOptions?: ProgressUpdateOptions;
  stopCardIdentity?: CachedStopCardIdentity;
  terminalControlIdentity?: CachedStopCardIdentity;
};

function progressCardKey(input: {
  chatJid: string;
  providerAccountId?: string;
  threadId?: string;
  generation?: number;
  providerCardIdentity?: string;
}): string {
  return [
    input.chatJid,
    input.providerAccountId ?? '',
    input.threadId ?? '',
    input.providerCardIdentity ??
      (input.generation === undefined ? '' : String(input.generation)),
  ].join('\n');
}

export function clearCachedCardIdentity(
  registry: ProgressCardIdentityRegistry,
  cached: CachedStopCardIdentity,
): void {
  if (registry.stopCardIdentityByRoute.get(cached.routeKey) !== cached) return;
  registry.stopCardIdentityByRoute.delete(cached.routeKey);
  if (cached.retentionTimer) clearTimeout(cached.retentionTimer);
  cached.retentionTimer = undefined;
}

function armIdentityRetention(
  registry: ProgressCardIdentityRegistry,
  cached: CachedStopCardIdentity,
): void {
  if (cached.retentionTimer) clearTimeout(cached.retentionTimer);
  cached.retentionTimer = setTimeout(() => {
    clearCachedCardIdentity(registry, cached);
  }, CONTROL_CARD_IDENTITY_RETENTION_MS);
  cached.retentionTimer.unref?.();
}

export function markStopCardIdentityLanded(
  registry: ProgressCardIdentityRegistry,
  cached: CachedStopCardIdentity,
): void {
  if (registry.stopCardIdentityByRoute.get(cached.routeKey) !== cached) return;
  cached.landed = true;
  armIdentityRetention(registry, cached);
}

export function deletePendingCardIdentity(
  registry: ProgressCardIdentityRegistry,
  cardKey: string,
): void {
  for (const cached of registry.stopCardIdentityByRoute.values()) {
    if (cached.cardKey === cardKey && !cached.landed) {
      clearCachedCardIdentity(registry, cached);
    }
  }
}

export function resolveProgressCardTarget(input: {
  registry: ProgressCardIdentityRegistry;
  chatJid: string;
  defaultProviderAccountId?: string;
  defaultThreadId?: string;
  options?: ProgressUpdateOptions;
  resolveProviderCardIdentity: (
    options?: ProgressUpdateOptions,
  ) => string | undefined;
  canRegisterStopCard: (cardKey: string) => boolean;
}): ProgressCardTarget {
  const providerAccountId =
    input.options?.providerAccountId ?? input.defaultProviderAccountId;
  const generation = input.options?.generation;
  const threadId = input.options?.threadId ?? input.defaultThreadId;
  const normalizedOptions =
    input.options || providerAccountId !== undefined || threadId !== undefined
      ? {
          ...input.options,
          ...(providerAccountId !== undefined ? { providerAccountId } : {}),
          ...(threadId !== undefined ? { threadId } : {}),
        }
      : undefined;
  const routeKey = JSON.stringify([
    input.chatJid,
    providerAccountId ?? null,
    threadId ?? null,
  ]);
  const hasStopAction = input.options?.actionAffordances?.some(
    (action) => action.kind === 'live_turn_stop',
  );
  let rejectedPendingControl = false;
  let terminalControlIdentity: CachedStopCardIdentity | undefined;
  let providerCardIdentity: string | undefined;
  const targetsExistingControl =
    !hasStopAction &&
    (input.options?.done === true || input.options?.replaceOnly === true);
  if (targetsExistingControl) {
    const pendingControl = input.registry.stopCardIdentityByRoute.get(routeKey);
    const mayBorrowPendingControl =
      pendingControl !== undefined &&
      (pendingControl.generation === undefined
        ? generation === undefined
        : generation !== undefined && generation >= pendingControl.generation);
    if (mayBorrowPendingControl) {
      providerCardIdentity = pendingControl.identity;
      if (input.options?.done) terminalControlIdentity = pendingControl;
    } else {
      rejectedPendingControl = pendingControl !== undefined;
      providerCardIdentity = input.resolveProviderCardIdentity(
        rejectedPendingControl
          ? { ...normalizedOptions, done: undefined }
          : input.options?.replaceOnly && !input.options.done
            ? { ...normalizedOptions, done: true }
            : normalizedOptions,
      );
    }
  } else {
    providerCardIdentity = input.resolveProviderCardIdentity(normalizedOptions);
  }
  const cardKey = progressCardKey({
    chatJid: input.chatJid,
    providerAccountId,
    threadId,
    generation,
    providerCardIdentity,
  });
  let stopCardIdentity: CachedStopCardIdentity | undefined;
  if (
    hasStopAction &&
    providerCardIdentity &&
    input.canRegisterStopCard(cardKey)
  ) {
    const previous = input.registry.stopCardIdentityByRoute.get(routeKey);
    if (previous) clearCachedCardIdentity(input.registry, previous);
    const cached: CachedStopCardIdentity = {
      routeKey,
      identity: providerCardIdentity,
      cardKey,
      landed: false,
      ...(generation !== undefined ? { generation } : {}),
    };
    stopCardIdentity = cached;
    input.registry.stopCardIdentityByRoute.set(routeKey, cached);
    armIdentityRetention(input.registry, cached);
  }
  const dispatchOptions =
    providerCardIdentity !== undefined || rejectedPendingControl
      ? {
          ...normalizedOptions,
          ...(providerCardIdentity !== undefined
            ? { progressCardIdentity: providerCardIdentity }
            : {}),
          ...(rejectedPendingControl ? { replaceOnly: true } : {}),
        }
      : normalizedOptions;
  return {
    key: cardKey,
    dispatchOptions,
    ...(stopCardIdentity ? { stopCardIdentity } : {}),
    ...(terminalControlIdentity ? { terminalControlIdentity } : {}),
  };
}
