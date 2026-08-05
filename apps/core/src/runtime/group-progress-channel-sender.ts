import type { ProgressUpdateOptions } from '../domain/types.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import {
  clearCachedCardIdentity,
  deletePendingCardIdentity,
  markStopCardIdentityLanded,
  resolveProgressCardTarget,
  type CachedStopCardIdentity,
  type ProgressCardIdentityRegistry,
  type ProgressCardTarget,
} from './group-progress-card-identity.js';

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
  stopCardIdentity?: CachedStopCardIdentity;
  terminalControlIdentity?: CachedStopCardIdentity;
  previousDesired?: DesiredProgressPayload;
};

type ProgressSendLink = {
  ownerEpoch: number;
  sequence: number;
  dispatched: boolean;
  nonBlocking: boolean;
  obsolete: boolean;
  stallNotice: boolean;
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
  unsettledAttemptCount: number;
  handleMayExist: boolean;
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

type ProgressOrderingRegistry = ProgressCardIdentityRegistry & {
  chains: Map<string, ProgressSendChain>;
};

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
  const created: ProgressOrderingRegistry = {
    chains: new Map(),
    stopCardIdentityByRoute: new Map(),
  };
  orderingRegistries.set(channelRuntime, created);
  return created;
}

export function progressOrderingRegistrySize(
  channelRuntime: GroupProcessingDeps['channelRuntime'],
): number {
  return orderingRegistries.get(channelRuntime)?.chains.size ?? 0;
}

export function progressCardIdentityCacheSize(
  channelRuntime: GroupProcessingDeps['channelRuntime'],
): number {
  return (
    orderingRegistries.get(channelRuntime)?.stopCardIdentityByRoute.size ?? 0
  );
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

function deleteChain(
  registry: ProgressOrderingRegistry,
  key: string,
  chain: ProgressSendChain,
): void {
  if (registry.chains.get(key) !== chain) return;
  registry.chains.delete(key);
  deletePendingCardIdentity(registry, key);
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
    registry.chains.get(key) === chain
  ) {
    if (chain.retentionTimer) clearTimeout(chain.retentionTimer);
    deleteChain(registry, key, chain);
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
      registry.chains.get(key) === chain
    ) {
      deleteChain(registry, key, chain);
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
    if (chain.currentOwner.retired && registry.chains.get(key) === chain) {
      deleteChain(registry, key, chain);
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
  }
}

function reconcile(
  registry: ProgressOrderingRegistry,
  key: string,
  chain: ProgressSendChain,
  trigger: 'original' | 'repair',
): void {
  if (registry.chains.get(key) !== chain) {
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
      registry.chains.get(key) !== chain
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
  let stopCardIdentity: CachedStopCardIdentity | undefined;
  let terminalControlIdentity: CachedStopCardIdentity | undefined;
  let repairLanded = false;
  const result = (async () => {
    if (previous) await waitForProgressLink(previous);
    let target = chain.lastDesired;
    while (target && !repairEligible(target)) target = chain.lastDesired;
    if (!target || target.ownerEpoch !== chain.currentOwnerEpoch) return false;
    if (chain.lastLandedSequence === target.sequence) return false;
    targetSequence = target.sequence;
    stopCardIdentity = target.stopCardIdentity;
    terminalControlIdentity = target.terminalControlIdentity;
    link.ownerEpoch = target.ownerEpoch;
    link.sequence = target.sequence;
    link.dispatched = true;
    const forceReplaceOnly =
      chain.handleMayExist || chain.unsettledAttemptCount > 0;
    if (chain.unsettledAttemptCount > 0) chain.handleMayExist = true;
    chain.unsettledAttemptCount += 1;
    try {
      const landed = await chain.currentOwner.sendPayload({
        ...target,
        options: forceReplaceOnly
          ? { ...target.options, replaceOnly: true }
          : target.options,
      });
      if (landed) {
        chain.handleMayExist = true;
      } else if (chain.unsettledAttemptCount === 1) {
        chain.handleMayExist = false;
      }
      return landed;
    } catch (err) {
      chain.handleMayExist = true;
      throw err;
    } finally {
      chain.unsettledAttemptCount -= 1;
    }
  })();

  link.settled = result.then(
    (landed) => {
      repairLanded = landed;
      if (landed && targetSequence !== undefined) {
        chain.lastLandedSequence = targetSequence;
        if (stopCardIdentity) {
          markStopCardIdentityLanded(registry, stopCardIdentity);
        }
        if (terminalControlIdentity) {
          clearCachedCardIdentity(registry, terminalControlIdentity);
        }
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
    if (registry.chains.get(key) !== chain) return;
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

  const targetFor = (options?: ProgressUpdateOptions): ProgressCardTarget => {
    return resolveProgressCardTarget({
      registry,
      chatJid: input.chatJid,
      defaultProviderAccountId: input.providerAccountId,
      defaultThreadId: input.threadId,
      options,
      resolveProviderCardIdentity: (identityOptions) =>
        input.channelRuntime.progressCardIdentity?.(
          input.chatJid,
          identityOptions,
        ),
      canRegisterStopCard: (cardKey) =>
        !owner.retired && !owner.supersededCards.has(cardKey),
    });
  };

  const claimCard = (key: string): ProgressSendChain | undefined => {
    if (owner.retired || owner.supersededCards.has(key)) return undefined;
    const owned = ownedCards.get(key);
    if (
      owned &&
      registry.chains.get(key) === owned &&
      owned.currentOwner === owner
    ) {
      return owned;
    }

    const existing = registry.chains.get(key);
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
      unsettledAttemptCount: 0,
      handleMayExist: false,
      repairDirty: false,
      repairRetryCount: 0,
      pending: new Set<ProgressSendLink>(),
      detachedCount: 0,
    };
    registry.chains.set(key, created);
    ownedCards.set(key, created);
    return created;
  };

  const enqueueOriginal = (
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<boolean> => {
    const { key, dispatchOptions, stopCardIdentity, terminalControlIdentity } =
      targetFor(options);
    const chain = claimCard(key);
    if (!chain) return Promise.resolve(false);
    if (options?.done) supersedePendingStallNotices(chain);
    const previous = chain.tail;
    const sequence = chain.nextSequence++;
    const link: ProgressSendLink = {
      ownerEpoch: chain.currentOwnerEpoch,
      sequence,
      dispatched: false,
      nonBlocking: false,
      obsolete: false,
      stallNotice: text === 'Still working',
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
      const desired: DesiredProgressPayload = {
        ownerEpoch: chain.currentOwnerEpoch,
        sequence,
        text,
        ...(dispatchOptions ? { options: { ...dispatchOptions } } : {}),
        ...(stopCardIdentity ? { stopCardIdentity } : {}),
        ...(terminalControlIdentity ? { terminalControlIdentity } : {}),
        ...(chain.lastDesired ? { previousDesired: chain.lastDesired } : {}),
      };
      chain.lastDesired = desired;
      link.dispatched = true;
      const forceReplaceOnly =
        chain.handleMayExist || chain.unsettledAttemptCount > 0;
      if (chain.unsettledAttemptCount > 0) chain.handleMayExist = true;
      chain.unsettledAttemptCount += 1;
      try {
        const landed = await owner.sendPayload({
          text,
          options: forceReplaceOnly
            ? { ...dispatchOptions, replaceOnly: true }
            : dispatchOptions,
        });
        if (landed) {
          chain.handleMayExist = true;
        } else if (chain.unsettledAttemptCount === 1) {
          chain.handleMayExist = false;
        }
        return landed;
      } catch (err) {
        chain.handleMayExist = true;
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
      } finally {
        chain.unsettledAttemptCount -= 1;
      }
    })();
    link.settled = result.then(
      (landed) => {
        originalLanded = landed;
        if (landed && stopCardIdentity) {
          markStopCardIdentityLanded(registry, stopCardIdentity);
        }
        if (landed && terminalControlIdentity) {
          clearCachedCardIdentity(registry, terminalControlIdentity);
        }
        if (landed) {
          chain.lastLandedSequence = link.sequence;
        }
      },
      () => undefined,
    );
    chain.tail = link;
    void link.settled.then(() => {
      if (link.nonBlocking) chain.detachedCount -= 1;
      if (registry.chains.get(key) !== chain) return;
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
    const { key } = targetFor(options);
    const chain = ownedCards.get(key);
    if (!chain || chain.currentOwner !== owner) return;
    supersedePendingStallNotices(chain);
    if (chain.tail) await waitForProgressLink(chain.tail);
  };
  sender.recordVisibleDelivery = (
    text: string,
    options?: ProgressUpdateOptions,
  ) => {
    const { key, dispatchOptions, terminalControlIdentity } =
      targetFor(options);
    const chain = claimCard(key);
    if (!chain) return;
    supersedePendingStallNotices(chain);
    const sequence = chain.nextSequence++;
    const previousDesired = chain.lastDesired;
    chain.lastDesired = {
      ownerEpoch: chain.currentOwnerEpoch,
      sequence,
      text,
      ...(dispatchOptions ? { options: { ...dispatchOptions } } : {}),
      ...(terminalControlIdentity ? { terminalControlIdentity } : {}),
      ...(previousDesired ? { previousDesired } : {}),
    };
    chain.lastLandedSequence = sequence;
    chain.handleMayExist = true;
    if (terminalControlIdentity) {
      clearCachedCardIdentity(registry, terminalControlIdentity);
    }
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
      if (registry.chains.get(key) === chain) {
        scheduleRetiredChainGc(registry, key, chain);
        scheduleRetiredChainRetentionCap(registry, key, chain);
      }
    }
  };
  return sender;
}
