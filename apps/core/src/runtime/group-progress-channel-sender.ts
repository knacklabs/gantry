import type { ProgressUpdateOptions } from '../domain/types.js';
import type { GroupProcessingDeps } from './group-processing-types.js';

type RuntimeLogger = {
  warn(input: unknown, message: string): void;
};

const PROGRESS_SEND_LINK_TIMEOUT_MS = 2_000;
const PROGRESS_REPAIR_BACKOFF_MS = [5_000, 30_000] as const;
const RETIRED_CHAIN_RETENTION_MS = 10 * 60_000;

type DesiredProgressPayload = {
  ownerEpoch: number;
  sequence: number;
  text: string;
  options?: ProgressUpdateOptions;
  previousDesired?: DesiredProgressPayload;
};

type ProgressSendLink = {
  ownerEpoch: number;
  sequence: number;
  dispatched: boolean;
  nonBlocking: boolean;
  obsolete: boolean;
  stallNotice: boolean;
  previousDesired?: DesiredProgressPayload;
  abandon(): void;
  settled: Promise<void>;
};

type ProgressSenderOwner = {
  retired: boolean;
  supersededCards: Set<string>;
  sendPayload(payload: {
    text: string;
    options?: ProgressUpdateOptions;
  }): Promise<boolean>;
  log: RuntimeLogger;
  chatJid: string;
  groupName: string;
  finalizingGenerations: Set<number>;
};

type ProgressSendChain = {
  nextSequence: number;
  currentOwnerEpoch: number;
  currentOwner: ProgressSenderOwner;
  tail?: ProgressSendLink;
  pendingRepair?: ProgressSendLink;
  repairDirty: boolean;
  repairRetryCount: number;
  repairRetryTimer?: ReturnType<typeof setTimeout>;
  retentionTimer?: ReturnType<typeof setTimeout>;
  pending: Set<ProgressSendLink>;
  detachedCount: number;
  lastDesired?: DesiredProgressPayload;
  lastLandedSequence?: number;
};

type ProgressOrderingRegistry = Map<string, ProgressSendChain>;

const orderingRegistries = new WeakMap<object, ProgressOrderingRegistry>();

export type ProgressChannelSender = ((
  text: string,
  options?: ProgressUpdateOptions,
) => Promise<boolean>) & {
  beforeVisibleDelivery(options?: ProgressUpdateOptions): Promise<void>;
  recordVisibleDelivery(text: string, options?: ProgressUpdateOptions): void;
  cancelPendingStallNotices(): void;
  retire(): void;
};

function orderingRegistryFor(
  channelRuntime: GroupProcessingDeps['channelRuntime'],
): ProgressOrderingRegistry {
  const existing = orderingRegistries.get(channelRuntime);
  if (existing) return existing;
  const created: ProgressOrderingRegistry = new Map();
  orderingRegistries.set(channelRuntime, created);
  return created;
}

export function progressOrderingRegistrySize(
  channelRuntime: GroupProcessingDeps['channelRuntime'],
): number {
  return orderingRegistries.get(channelRuntime)?.size ?? 0;
}

function progressCardKey(input: {
  chatJid: string;
  providerAccountId?: string;
  threadId?: string;
}): string {
  return [
    input.chatJid,
    input.providerAccountId ?? '',
    input.threadId ?? '',
  ].join('\n');
}

async function waitForProgressLink(link: ProgressSendLink): Promise<void> {
  if (link.nonBlocking) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    link.settled.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), PROGRESS_SEND_LINK_TIMEOUT_MS);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!settled) link.abandon();
}

function maybeDeleteQuiescentChain(
  registry: ProgressOrderingRegistry,
  key: string,
  chain: ProgressSendChain,
): void {
  if (
    chain.pending.size === 0 &&
    !chain.pendingRepair &&
    !chain.repairRetryTimer &&
    chain.detachedCount === 0 &&
    registry.get(key) === chain
  ) {
    if (chain.retentionTimer) clearTimeout(chain.retentionTimer);
    registry.delete(key);
  }
}

function resetRepairEpisode(chain: ProgressSendChain): void {
  chain.repairRetryCount = 0;
  if (chain.repairRetryTimer) clearTimeout(chain.repairRetryTimer);
  chain.repairRetryTimer = undefined;
}

function scheduleRetiredChainGc(
  registry: ProgressOrderingRegistry,
  key: string,
  chain: ProgressSendChain,
): void {
  setTimeout(() => {
    if (
      chain.currentOwner.retired &&
      chain.pending.size === 0 &&
      !chain.pendingRepair &&
      !chain.repairRetryTimer &&
      chain.detachedCount === 0 &&
      registry.get(key) === chain
    ) {
      registry.delete(key);
    }
  }, PROGRESS_SEND_LINK_TIMEOUT_MS);
}

function scheduleRetiredChainRetentionCap(
  registry: ProgressOrderingRegistry,
  key: string,
  chain: ProgressSendChain,
): void {
  if (chain.retentionTimer) return;
  chain.retentionTimer = setTimeout(() => {
    chain.retentionTimer = undefined;
    if (chain.currentOwner.retired && registry.get(key) === chain) {
      registry.delete(key);
      if (chain.repairRetryTimer) clearTimeout(chain.repairRetryTimer);
      chain.repairRetryTimer = undefined;
      for (const link of [...chain.pending]) link.abandon();
      chain.pending.clear();
      chain.pendingRepair = undefined;
      chain.repairDirty = false;
    }
  }, RETIRED_CHAIN_RETENTION_MS);
  chain.retentionTimer.unref?.();
}

function supersedePendingStallNotices(chain?: ProgressSendChain): void {
  if (!chain) return;
  const pending = [...chain.pending].sort(
    (left, right) => right.sequence - left.sequence,
  );
  for (const link of pending) {
    if (link.dispatched || !link.stallNotice) continue;
    link.obsolete = true;
    if (chain.lastDesired?.sequence === link.sequence) {
      chain.lastDesired = link.previousDesired;
    }
  }
}

function reconcile(
  registry: ProgressOrderingRegistry,
  key: string,
  chain: ProgressSendChain,
  trigger: 'original' | 'repair',
): void {
  if (registry.get(key) !== chain) {
    resetRepairEpisode(chain);
    if (chain.retentionTimer) clearTimeout(chain.retentionTimer);
    chain.retentionTimer = undefined;
    return;
  }
  const latest = chain.lastDesired;
  if (chain.pendingRepair) {
    if (trigger === 'original') chain.repairDirty = true;
    return;
  }
  if (
    !latest ||
    latest.ownerEpoch !== chain.currentOwnerEpoch ||
    chain.lastLandedSequence === latest.sequence
  ) {
    maybeDeleteQuiescentChain(registry, key, chain);
    return;
  }

  const scheduleRepairRetry = () => {
    if (
      chain.repairRetryTimer ||
      chain.repairRetryCount >= PROGRESS_REPAIR_BACKOFF_MS.length ||
      registry.get(key) !== chain
    ) {
      maybeDeleteQuiescentChain(registry, key, chain);
      return;
    }
    const delay = PROGRESS_REPAIR_BACKOFF_MS[chain.repairRetryCount++];
    chain.repairRetryTimer = setTimeout(() => {
      chain.repairRetryTimer = undefined;
      reconcile(registry, key, chain, 'repair');
    }, delay);
    chain.repairRetryTimer.unref?.();
  };

  const repairEligible = (payload: DesiredProgressPayload): boolean => {
    if (
      payload.options?.done !== true &&
      payload.options?.generation !== undefined &&
      chain.currentOwner.finalizingGenerations.has(payload.options.generation)
    ) {
      if (chain.lastDesired?.sequence === payload.sequence) {
        chain.lastDesired = payload.previousDesired;
      }
      return false;
    }
    return true;
  };

  const previous = chain.tail;
  let repairFailureHandled = false;
  const link: ProgressSendLink = {
    ownerEpoch: chain.currentOwnerEpoch,
    sequence: latest.sequence,
    dispatched: false,
    nonBlocking: false,
    obsolete: false,
    stallNotice: false,
    abandon: () => undefined,
    settled: Promise.resolve(),
  };
  link.abandon = () => {
    if (link.nonBlocking) return;
    link.nonBlocking = true;
    chain.pending.delete(link);
    chain.detachedCount += 1;
    if (chain.pendingRepair === link) chain.pendingRepair = undefined;
    const repairDirty = chain.repairDirty;
    chain.repairDirty = false;
    if (repairDirty) reconcile(registry, key, chain, 'repair');
    else {
      repairFailureHandled = true;
      scheduleRepairRetry();
      if (chain.currentOwner.retired) {
        scheduleRetiredChainGc(registry, key, chain);
      }
    }
  };
  chain.pendingRepair = link;
  chain.pending.add(link);

  let targetSequence: number | undefined;
  let repairLanded = false;
  const result = (async () => {
    if (previous) await waitForProgressLink(previous);
    let target = chain.lastDesired;
    while (target && !repairEligible(target)) target = chain.lastDesired;
    if (!target || target.ownerEpoch !== chain.currentOwnerEpoch) return false;
    if (chain.lastLandedSequence === target.sequence) return false;
    targetSequence = target.sequence;
    link.ownerEpoch = target.ownerEpoch;
    link.sequence = target.sequence;
    link.dispatched = true;
    return chain.currentOwner.sendPayload(target);
  })();

  link.settled = result.then(
    (landed) => {
      repairLanded = landed;
      if (landed && targetSequence !== undefined) {
        chain.lastLandedSequence = targetSequence;
      }
    },
    (err) => {
      const owner = chain.currentOwner;
      owner.log.warn(
        { err, chatJid: owner.chatJid, group: owner.groupName },
        'Progress lifecycle repair send failed',
      );
    },
  );
  chain.tail = link;
  const abandonmentTimer = setTimeout(
    () => link.abandon(),
    PROGRESS_SEND_LINK_TIMEOUT_MS,
  );
  void link.settled.then(() => {
    clearTimeout(abandonmentTimer);
    if (link.nonBlocking) chain.detachedCount -= 1;
    if (registry.get(key) !== chain) return;
    chain.pending.delete(link);
    if (chain.pendingRepair === link) chain.pendingRepair = undefined;
    const repairDirty = chain.repairDirty;
    chain.repairDirty = false;
    const repairedCurrentDesired =
      repairLanded &&
      targetSequence !== undefined &&
      chain.lastDesired?.ownerEpoch === chain.currentOwnerEpoch &&
      chain.lastDesired.sequence === targetSequence;
    if (repairedCurrentDesired) resetRepairEpisode(chain);
    if (repairLanded || repairDirty) {
      reconcile(registry, key, chain, 'repair');
    } else if (!repairFailureHandled) scheduleRepairRetry();
  });
}

export function createProgressChannelSender(input: {
  channelRuntime: GroupProcessingDeps['channelRuntime'];
  chatJid: string;
  groupName: string;
  providerAccountId?: string;
  threadId?: string;
  finalizingGenerations: Set<number>;
  log: RuntimeLogger;
}): ProgressChannelSender {
  const registry = orderingRegistryFor(input.channelRuntime);
  const ownedCards = new Map<string, ProgressSendChain>();

  const owner: ProgressSenderOwner = {
    retired: false,
    supersededCards: new Set<string>(),
    sendPayload: async (payload) => {
      if (payload.options) {
        return (
          (await input.channelRuntime.sendProgressUpdate(
            input.chatJid,
            payload.text,
            payload.options,
          )) !== false
        );
      }
      return (
        (await input.channelRuntime.sendProgressUpdate(
          input.chatJid,
          payload.text,
        )) !== false
      );
    },
    log: input.log,
    chatJid: input.chatJid,
    groupName: input.groupName,
    finalizingGenerations: input.finalizingGenerations,
  };

  const keyFor = (options?: ProgressUpdateOptions) =>
    progressCardKey({
      chatJid: input.chatJid,
      providerAccountId: options?.providerAccountId ?? input.providerAccountId,
      threadId: options?.threadId ?? input.threadId,
    });

  const claimCard = (key: string): ProgressSendChain | undefined => {
    if (owner.retired || owner.supersededCards.has(key)) return undefined;
    const owned = ownedCards.get(key);
    if (owned && registry.get(key) === owned && owned.currentOwner === owner) {
      return owned;
    }

    const existing = registry.get(key);
    if (existing) {
      if (existing.retentionTimer) clearTimeout(existing.retentionTimer);
      existing.retentionTimer = undefined;
      existing.currentOwner.supersededCards.add(key);
      existing.currentOwnerEpoch += 1;
      existing.currentOwner = owner;
      existing.lastDesired = undefined;
      ownedCards.set(key, existing);
      return existing;
    }

    const created: ProgressSendChain = {
      nextSequence: 0,
      currentOwnerEpoch: 0,
      currentOwner: owner,
      repairDirty: false,
      repairRetryCount: 0,
      pending: new Set<ProgressSendLink>(),
      detachedCount: 0,
    };
    registry.set(key, created);
    ownedCards.set(key, created);
    return created;
  };

  const enqueueOriginal = (
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<boolean> => {
    const key = keyFor(options);
    const chain = claimCard(key);
    if (!chain) return Promise.resolve(false);
    if (options?.done) supersedePendingStallNotices(chain);
    const previous = chain.tail;
    const sequence = chain.nextSequence++;
    const previousDesired = chain.lastDesired;
    const link: ProgressSendLink = {
      ownerEpoch: chain.currentOwnerEpoch,
      sequence,
      dispatched: false,
      nonBlocking: false,
      obsolete: false,
      stallNotice: text === 'Still working',
      previousDesired,
      abandon: () => undefined,
      settled: Promise.resolve(),
    };
    link.abandon = () => {
      if (link.nonBlocking) return;
      link.nonBlocking = true;
      chain.pending.delete(link);
      chain.detachedCount += 1;
      if (chain.currentOwner.retired) {
        scheduleRetiredChainGc(registry, key, chain);
      }
    };
    chain.pending.add(link);
    let originalLanded = false;
    const result = (async () => {
      if (previous) await waitForProgressLink(previous);
      if (owner.retired || owner.supersededCards.has(key)) return false;
      if (link.ownerEpoch !== chain.currentOwnerEpoch) return false;
      if (link.obsolete) return false;
      if (
        options?.done !== true &&
        options?.generation !== undefined &&
        input.finalizingGenerations.has(options.generation)
      ) {
        return false;
      }
      if (
        chain.lastDesired &&
        chain.lastDesired.ownerEpoch === chain.currentOwnerEpoch &&
        chain.lastDesired.sequence > sequence
      ) {
        return false;
      }
      chain.lastDesired = {
        ownerEpoch: chain.currentOwnerEpoch,
        sequence,
        text,
        ...(options ? { options: { ...options } } : {}),
        ...(chain.lastDesired ? { previousDesired: chain.lastDesired } : {}),
      };
      link.dispatched = true;
      try {
        return await owner.sendPayload({ text, options });
      } catch (err) {
        input.log.warn(
          {
            err,
            chatJid: input.chatJid,
            group: input.groupName,
            progressText: text,
            done: options?.done ?? false,
            replaceOnly: options?.replaceOnly ?? false,
            generation: options?.generation,
            threadId: options?.threadId,
          },
          'Progress lifecycle runtime send failed',
        );
        throw err;
      }
    })();
    link.settled = result.then(
      (landed) => {
        originalLanded = landed;
        if (landed) chain.lastLandedSequence = link.sequence;
      },
      () => undefined,
    );
    chain.tail = link;
    void link.settled.then(() => {
      if (link.nonBlocking) chain.detachedCount -= 1;
      if (registry.get(key) !== chain) return;
      chain.pending.delete(link);
      const isCurrentDesiredSettlement =
        chain.lastDesired?.ownerEpoch === link.ownerEpoch &&
        chain.lastDesired.sequence === link.sequence;
      if (isCurrentDesiredSettlement) resetRepairEpisode(chain);
      if (link.obsolete) {
        maybeDeleteQuiescentChain(registry, key, chain);
        return;
      }
      if (link.stallNotice && !originalLanded) {
        maybeDeleteQuiescentChain(registry, key, chain);
        return;
      }
      reconcile(registry, key, chain, 'original');
    });
    return result;
  };

  const sender = enqueueOriginal as ProgressChannelSender;
  sender.beforeVisibleDelivery = async (options?: ProgressUpdateOptions) => {
    if (owner.retired) return;
    const key = keyFor(options);
    const chain = ownedCards.get(key);
    if (!chain || chain.currentOwner !== owner) return;
    supersedePendingStallNotices(chain);
    if (chain.tail) await waitForProgressLink(chain.tail);
  };
  sender.recordVisibleDelivery = (
    text: string,
    options?: ProgressUpdateOptions,
  ) => {
    const key = keyFor(options);
    const chain = claimCard(key);
    if (!chain) return;
    supersedePendingStallNotices(chain);
    const sequence = chain.nextSequence++;
    const previousDesired = chain.lastDesired;
    chain.lastDesired = {
      ownerEpoch: chain.currentOwnerEpoch,
      sequence,
      text,
      ...(options ? { options: { ...options } } : {}),
      ...(previousDesired ? { previousDesired } : {}),
    };
    chain.lastLandedSequence = sequence;
    maybeDeleteQuiescentChain(registry, key, chain);
  };
  sender.cancelPendingStallNotices = () => {
    if (owner.retired) return;
    for (const chain of ownedCards.values()) {
      if (chain.currentOwner === owner) supersedePendingStallNotices(chain);
    }
  };
  sender.retire = () => {
    if (owner.retired) return;
    owner.retired = true;
    for (const [key, chain] of ownedCards) {
      maybeDeleteQuiescentChain(registry, key, chain);
      if (registry.get(key) === chain) {
        scheduleRetiredChainGc(registry, key, chain);
        scheduleRetiredChainRetentionCap(registry, key, chain);
      }
    }
  };
  return sender;
}
