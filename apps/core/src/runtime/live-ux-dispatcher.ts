import {
  LiveUxRateLimitError,
  type ChannelLiveUxCapability,
  type MessageReactionRemovalSink,
  type MessageReactionSink,
  type TypingSink,
} from '../domain/channel-live-ux.js';

const DEFAULT_LIVE_UX_ATTEMPT_DEADLINE_MS = 2_000;
const DEFAULT_LIVE_UX_SETTLEMENT_GRACE_MS = 250;
const DEFAULT_LIVE_UX_ABANDONED_ATTEMPT_RETENTION_MS = 30_000;
const DEFAULT_LIVE_UX_ABANDONED_ATTEMPT_LIMIT = 256;

type LiveUxRoute = {
  jid: string;
  providerAccountId?: string;
  threadId?: string;
};

type LiveUxLogger = {
  warn(context: Record<string, unknown>, message: string): void;
};

export type LiveUxChannel = {
  liveUx?: ChannelLiveUxCapability;
  setTyping?: TypingSink['setTyping'];
  addReaction?: MessageReactionSink['addReaction'];
  removeReaction?: MessageReactionRemovalSink['removeReaction'];
};

export type LiveUxBinding = {
  channel: LiveUxChannel;
  identity: object;
};

type TargetWork = {
  attempt: 1 | 2;
  context: Record<string, unknown>;
  desiredKey: string;
  run: (signal: AbortSignal, reconcile?: boolean) => Promise<void> | undefined;
  shouldSkip?: () => boolean;
  onConfirmed?: () => void;
  complete: (confirmed: boolean) => void;
};

type TargetQueue = {
  inFlight?: TargetWork;
  queued?: TargetWork;
  cooldown: boolean;
};

type TargetWorkInput = Omit<TargetWork, 'attempt' | 'complete'>;

type DesiredTargetState = {
  work: TargetWorkInput;
  unsettled: Set<symbol>;
};

type AbandonedAttempt = {
  binding?: LiveUxBinding;
  target?: string;
  state?: DesiredTargetState;
  marker?: symbol;
  context?: Record<string, unknown>;
  desiredKey: string;
  retentionTimer?: ReturnType<typeof setTimeout>;
};

type AttemptSettlement =
  | { kind: 'confirmed' }
  | { kind: 'failed'; error: unknown };

type AttemptOutcome =
  | AttemptSettlement
  | { kind: 'timed-out'; settled: Promise<AttemptSettlement> };

export function createLiveUxDispatcher(input: {
  findBinding: (
    jid: string,
    providerAccountId?: string,
  ) => LiveUxBinding | undefined;
  logger: LiveUxLogger;
  attemptDeadlineMs?: number;
  settlementGraceMs?: number;
  abandonedAttemptRetentionMs?: number;
  abandonedAttemptLimit?: number;
  wait?: (delayMs: number) => Promise<void>;
}) {
  const queuesByBinding = new WeakMap<object, Map<string, TargetQueue>>();
  const desiredByBinding = new WeakMap<
    object,
    Map<string, DesiredTargetState>
  >();
  const abandonedAttempts = new Set<AbandonedAttempt>();
  let pendingTargetCount = 0;
  let retainedDesiredTargetCount = 0;
  const attemptDeadlineMs =
    input.attemptDeadlineMs ?? DEFAULT_LIVE_UX_ATTEMPT_DEADLINE_MS;
  const settlementGraceMs =
    input.settlementGraceMs ?? DEFAULT_LIVE_UX_SETTLEMENT_GRACE_MS;
  const abandonedAttemptRetentionMs =
    input.abandonedAttemptRetentionMs ??
    DEFAULT_LIVE_UX_ABANDONED_ATTEMPT_RETENTION_MS;
  const abandonedAttemptLimit = Math.max(
    1,
    Math.floor(
      input.abandonedAttemptLimit ?? DEFAULT_LIVE_UX_ABANDONED_ATTEMPT_LIMIT,
    ),
  );
  const wait =
    input.wait ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      }));

  const runAttempt = async (work: TargetWork): Promise<AttemptOutcome> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const settled = Promise.resolve()
      .then(() => work.run(controller.signal))
      .then<AttemptSettlement, AttemptSettlement>(
        () => ({ kind: 'confirmed' }),
        (error: unknown) => ({ kind: 'failed', error }),
      );
    const timeout = new Promise<{ kind: 'timed-out' }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Live UX delivery attempt timed out'));
        resolve({ kind: 'timed-out' });
      }, attemptDeadlineMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([settled, timeout]);
    if (outcome.kind !== 'timed-out') {
      if (timer) clearTimeout(timer);
      return outcome;
    }
    return { ...outcome, settled };
  };

  const mapFor = (binding: LiveUxBinding) => {
    let queues = queuesByBinding.get(binding.identity);
    if (!queues) {
      queues = new Map<string, TargetQueue>();
      queuesByBinding.set(binding.identity, queues);
    }
    return queues;
  };

  const rememberDesired = (
    binding: LiveUxBinding,
    target: string,
    work: TargetWorkInput,
  ) => {
    let desiredByTarget = desiredByBinding.get(binding.identity);
    if (!desiredByTarget) {
      desiredByTarget = new Map<string, DesiredTargetState>();
      desiredByBinding.set(binding.identity, desiredByTarget);
    }
    const state = desiredByTarget.get(target);
    if (state) {
      state.work = work;
      return state;
    }
    const created = { work, unsettled: new Set<symbol>() };
    desiredByTarget.set(target, created);
    retainedDesiredTargetCount += 1;
    return created;
  };

  const deleteDesiredState = (
    binding: LiveUxBinding,
    target: string,
    state: DesiredTargetState,
  ) => {
    const desiredByTarget = desiredByBinding.get(binding.identity);
    if (desiredByTarget?.get(target) !== state) return;
    desiredByTarget.delete(target);
    retainedDesiredTargetCount -= 1;
    if (desiredByTarget.size === 0) {
      desiredByBinding.delete(binding.identity);
    }
  };

  const forgetDesiredIfSettled = (binding: LiveUxBinding, target: string) => {
    const desiredByTarget = desiredByBinding.get(binding.identity);
    const state = desiredByTarget?.get(target);
    if (!state || state.unsettled.size !== 0) return;
    deleteDesiredState(binding, target, state);
  };

  const workInput = (work: TargetWork): TargetWorkInput => ({
    context: work.context,
    desiredKey: work.desiredKey,
    run: work.run,
    shouldSkip: work.shouldSkip,
    onConfirmed: work.onConfirmed,
  });

  const releaseAbandoned = (
    attempt: AbandonedAttempt,
    options: { reconcile: boolean; evictionReason?: 'limit' | 'expiry' },
  ) => {
    if (!abandonedAttempts.delete(attempt)) return;
    if (attempt.retentionTimer) clearTimeout(attempt.retentionTimer);
    const { binding, target, state, marker, context } = attempt;
    if (!binding || target === undefined || !state || !marker) return;
    state.unsettled.delete(marker);
    const current = desiredByBinding.get(binding.identity)?.get(target);
    const desiredWork =
      options.reconcile &&
      current &&
      current.work.desiredKey !== attempt.desiredKey
        ? current.work
        : undefined;

    if (options.evictionReason) {
      // After this bounded eviction, a provider effect that lands even later
      // cannot be observed or reconciled. Reassert the newest differing value
      // once now; the narrow residual is deliberately warn-visible rather than
      // retaining target state without bound.
      input.logger.warn(
        {
          ...context,
          abandonedAttemptEviction: options.evictionReason,
          residual:
            'A provider effect landing after eviction cannot be reconciled',
        },
        'Live UX abandoned attempt retention evicted',
      );
    }

    if (current === state && state.unsettled.size === 0) {
      deleteDesiredState(binding, target, state);
    }
    attempt.binding = undefined;
    attempt.target = undefined;
    attempt.state = undefined;
    attempt.marker = undefined;
    attempt.context = undefined;
    attempt.retentionTimer = undefined;

    if (desiredWork) {
      void enqueue(binding, target, {
        ...desiredWork,
        shouldSkip: undefined,
        run: (signal) => desiredWork.run(signal, true),
      });
    }
  };

  const trackAbandoned = (
    binding: LiveUxBinding,
    target: string,
    work: TargetWork,
    settled: Promise<AttemptSettlement>,
  ) => {
    const state =
      desiredByBinding.get(binding.identity)?.get(target) ??
      rememberDesired(binding, target, workInput(work));
    const attemptMarker = Symbol('abandoned-live-ux-attempt');
    state.unsettled.add(attemptMarker);
    const attempt: AbandonedAttempt = {
      binding,
      target,
      state,
      marker: attemptMarker,
      context: work.context,
      desiredKey: work.desiredKey,
    };
    abandonedAttempts.add(attempt);
    attempt.retentionTimer = setTimeout(() => {
      releaseAbandoned(attempt, { reconcile: true, evictionReason: 'expiry' });
    }, abandonedAttemptRetentionMs);
    attempt.retentionTimer.unref?.();
    while (abandonedAttempts.size > abandonedAttemptLimit) {
      const oldest = abandonedAttempts.values().next().value;
      if (!oldest) break;
      releaseAbandoned(oldest, { reconcile: true, evictionReason: 'limit' });
    }
    void settled.then((settlement) => {
      if (settlement.kind !== 'confirmed') return;
      // Abort is advisory at remote commit boundaries. A confirmed abandoned
      // effect re-enters the same serialized lane with the newest value.
      releaseAbandoned(attempt, { reconcile: true });
    });
  };

  const removeSettledQueue = (
    binding: LiveUxBinding,
    target: string,
    queue: TargetQueue,
  ) => {
    if (queue.inFlight || queue.queued || queue.cooldown) return;
    const queues = queuesByBinding.get(binding.identity);
    if (queues?.get(target) !== queue) return;
    queues.delete(target);
    pendingTargetCount -= 1;
    if (queues.size === 0) queuesByBinding.delete(binding.identity);
  };

  const completeSuperseded = (work: TargetWork | undefined) => {
    work?.complete(false);
  };

  const runNext = (
    binding: LiveUxBinding,
    target: string,
    queue: TargetQueue,
  ) => {
    if (queue.cooldown) return;
    const next = queue.queued;
    if (!next) {
      removeSettledQueue(binding, target, queue);
      return;
    }
    queue.queued = undefined;
    queue.inFlight = next;
    void runWork(binding, target, queue, next);
  };

  const finish = (
    binding: LiveUxBinding,
    target: string,
    queue: TargetQueue,
    work: TargetWork,
  ) => {
    if (queue.inFlight === work) queue.inFlight = undefined;
    runNext(binding, target, queue);
  };

  const queueRetry = (
    binding: LiveUxBinding,
    target: string,
    queue: TargetQueue,
    work: TargetWork,
    rateLimit: LiveUxRateLimitError,
  ) => {
    if (queue.inFlight === work) queue.inFlight = undefined;
    const retry: TargetWork = { ...work, attempt: 2 };
    queue.cooldown = true;
    if (queue.queued) {
      work.complete(false);
    } else {
      queue.queued = retry;
    }
    void wait(rateLimit.retryDelayMs).then(
      () => {
        queue.cooldown = false;
        runNext(binding, target, queue);
      },
      (error: unknown) => {
        queue.cooldown = false;
        const failed = queue.queued;
        queue.queued = undefined;
        input.logger.warn(
          { ...(failed?.context ?? work.context), err: error },
          'Live UX delivery failed after rate-limit retry',
        );
        failed?.complete(false);
        removeSettledQueue(binding, target, queue);
      },
    );
  };

  const runWork = async (
    binding: LiveUxBinding,
    target: string,
    queue: TargetQueue,
    work: TargetWork,
  ): Promise<void> => {
    if (work.shouldSkip?.()) {
      work.complete(true);
      forgetDesiredIfSettled(binding, target);
      finish(binding, target, queue, work);
      return;
    }
    const outcome = await runAttempt(work);
    if (outcome.kind === 'confirmed') {
      work.onConfirmed?.();
      work.complete(true);
      forgetDesiredIfSettled(binding, target);
      finish(binding, target, queue, work);
      return;
    }
    if (outcome.kind === 'timed-out') {
      input.logger.warn(
        {
          ...work.context,
          err: new Error('Live UX delivery attempt timed out'),
        },
        'Live UX delivery failed',
      );
      work.complete(false);
      // Abort is advisory. Keep the lane through a short settlement grace;
      // an abort-ignoring adapter cannot hold it forever. Deadline-fired
      // work stays ambiguous because local rejection cannot prove a remote miss.
      trackAbandoned(binding, target, work, outcome.settled);
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        outcome.settled,
        new Promise<{ kind: 'grace-expired' }>((resolve) => {
          graceTimer = setTimeout(
            () => resolve({ kind: 'grace-expired' }),
            settlementGraceMs,
          );
          graceTimer.unref?.();
        }),
      ]);
      if (graceTimer) clearTimeout(graceTimer);
      finish(binding, target, queue, work);
      return;
    }
    if (outcome.error instanceof LiveUxRateLimitError && work.attempt === 1) {
      if (outcome.error.retryDelayMs > attemptDeadlineMs) {
        input.logger.warn(
          { ...work.context, retryDelayMs: outcome.error.retryDelayMs },
          'Live UX retry declined: delay exceeds wait bound',
        );
        work.complete(false);
        forgetDesiredIfSettled(binding, target);
        finish(binding, target, queue, work);
        return;
      }
      input.logger.warn(
        {
          ...work.context,
          err: outcome.error.cause,
          retryDelayMs: outcome.error.retryDelayMs,
        },
        'Live UX delivery rate-limited; retrying once',
      );
      queueRetry(binding, target, queue, work, outcome.error);
      return;
    }
    input.logger.warn(
      { ...work.context, err: outcome.error },
      work.attempt === 2
        ? 'Live UX delivery failed after rate-limit retry'
        : 'Live UX delivery failed',
    );
    work.complete(false);
    forgetDesiredIfSettled(binding, target);
    finish(binding, target, queue, work);
  };

  function enqueue(
    binding: LiveUxBinding,
    target: string,
    workInput: TargetWorkInput,
  ): Promise<boolean> {
    let completed = false;
    let resolveResult: (confirmed: boolean) => void = () => undefined;
    const result = new Promise<boolean>((resolve) => {
      resolveResult = resolve;
    });
    const work: TargetWork = {
      ...workInput,
      attempt: 1,
      complete: (confirmed) => {
        if (completed) return;
        completed = true;
        resolveResult(confirmed);
      },
    };
    rememberDesired(binding, target, workInput);
    const queues = mapFor(binding);
    let queue = queues.get(target);
    if (!queue) {
      queue = { cooldown: false };
      queues.set(target, queue);
      pendingTargetCount += 1;
    }
    if (queue.inFlight || queue.cooldown) {
      completeSuperseded(queue.queued);
      queue.queued = work;
      return result;
    }
    if (queue.queued) {
      completeSuperseded(queue.queued);
      queue.queued = undefined;
    }
    queue.inFlight = work;
    void runWork(binding, target, queue, work);
    return result;
  }
  const resolvedTargetOptions = (target: unknown) =>
    target === undefined ? {} : { resolvedTarget: target };
  const canonicalTarget = (
    channel: LiveUxChannel,
    target: Parameters<ChannelLiveUxCapability['canonicalTarget']>[0],
    context: Record<string, unknown>,
  ): { key: string; resolvedTarget?: unknown } => {
    // Key failures degrade to less coalescing, never a dropped operation.
    const fallback = [
      target.operation,
      target.jid,
      target.threadId ?? '',
      'messageRef' in target ? target.messageRef : '',
      'emoji' in target ? target.emoji : '',
    ].join('\n');
    try {
      const resolved = channel.liveUx?.canonicalTarget(target);
      if (resolved?.key) return resolved;
      input.logger.warn(
        context,
        'Live UX capability returned an empty canonical target',
      );
    } catch (error) {
      input.logger.warn(
        { ...context, err: error },
        'Live UX canonical target resolution failed',
      );
    }
    return { key: fallback };
  };

  const resolveBinding = (
    route: LiveUxRoute,
    operation: 'typing' | 'reaction.add' | 'reaction.remove',
  ): LiveUxBinding | undefined => {
    const binding = input.findBinding(route.jid, route.providerAccountId);
    if (!binding) {
      input.logger.warn(
        { operation, ...route },
        'Live UX delivery sink could not be resolved',
      );
    }
    return binding;
  };
  return {
    reactionRemovalMode: (
      jid: string,
      options?: { providerAccountId?: string },
    ): 'exact' | 'all' | undefined => {
      const reactions = input.findBinding(jid, options?.providerAccountId)
        ?.channel.liveUx?.reactions;
      return reactions === 'none' ? undefined : reactions?.removal;
    },
    setTyping: async (
      jid: string,
      isTyping: boolean,
      options?: { providerAccountId?: string; threadId?: string },
    ) => {
      const route = { jid, ...options };
      const binding = resolveBinding(route, 'typing');
      if (!binding) return;
      const channel = binding.channel;
      if (!channel.liveUx || channel.liveUx.typing === 'none') return;
      if (!channel.setTyping) {
        input.logger.warn(
          { operation: 'typing', ...route },
          'Live UX capability is declared without a typing operation',
        );
        return;
      }
      const context = {
        operation: 'typing',
        jid,
        providerAccountId: options?.providerAccountId,
        threadId: options?.threadId,
      };
      const resolvedTarget = canonicalTarget(
        channel,
        { operation: 'typing', jid, threadId: options?.threadId },
        context,
      );
      await enqueue(binding, resolvedTarget.key, {
        context,
        desiredKey: `typing:${String(isTyping)}`,
        run: (signal) =>
          channel.setTyping?.(jid, isTyping, {
            ...(options?.threadId ? { threadId: options.threadId } : {}),
            signal,
            ...resolvedTargetOptions(resolvedTarget.resolvedTarget),
          }),
      });
    },
    addReaction: async (
      jid: string,
      messageRef: string,
      emoji: string,
      options?: { providerAccountId?: string; threadId?: string },
    ) => {
      const route = { jid, ...options };
      const binding = resolveBinding(route, 'reaction.add');
      if (!binding) return;
      const channel = binding.channel;
      if (!channel.liveUx || channel.liveUx.reactions === 'none') return;
      if (!channel.addReaction) {
        input.logger.warn(
          { operation: 'reaction.add', ...route, messageRef },
          'Live UX capability is declared without a reaction operation',
        );
        return;
      }
      const context = {
        operation: 'reaction.add',
        jid,
        providerAccountId: options?.providerAccountId,
        threadId: options?.threadId,
        messageRef,
      };
      const resolvedTarget = canonicalTarget(
        channel,
        {
          operation: 'reaction',
          jid,
          threadId: options?.threadId,
          messageRef,
          emoji,
        },
        context,
      );
      await enqueue(binding, resolvedTarget.key, {
        context,
        desiredKey: `reaction:add:${emoji}`,
        run: (signal, reconcile) =>
          channel.addReaction?.(jid, messageRef, emoji, {
            ...(options?.threadId ? { threadId: options.threadId } : {}),
            signal,
            ...resolvedTargetOptions(resolvedTarget.resolvedTarget),
            ...(reconcile ? { reconcile: true } : {}),
          }),
      });
    },
    removeReaction: async (
      jid: string,
      messageRef: string,
      emoji: string,
      options?: { providerAccountId?: string; threadId?: string },
    ) => {
      const route = { jid, ...options };
      const binding = resolveBinding(route, 'reaction.remove');
      if (!binding) return;
      const channel = binding.channel;
      if (!channel.liveUx || channel.liveUx.reactions === 'none') return;
      if (!channel.removeReaction) {
        input.logger.warn(
          { operation: 'reaction.remove', ...route, messageRef },
          'Live UX capability is declared without a reaction removal operation',
        );
        return;
      }
      const context = {
        operation: 'reaction.remove',
        jid,
        providerAccountId: options?.providerAccountId,
        threadId: options?.threadId,
        messageRef,
      };
      const resolvedTarget = canonicalTarget(
        channel,
        {
          operation: 'reaction',
          jid,
          threadId: options?.threadId,
          messageRef,
          emoji,
        },
        context,
      );
      await enqueue(binding, resolvedTarget.key, {
        context,
        desiredKey: `reaction:remove:${emoji}`,
        run: (signal, reconcile) =>
          channel.removeReaction?.(jid, messageRef, emoji, {
            ...(options?.threadId ? { threadId: options.threadId } : {}),
            signal,
            ...resolvedTargetOptions(resolvedTarget.resolvedTarget),
            ...(reconcile ? { reconcile: true } : {}),
          }),
      });
    },
    pendingTargetCount: () => pendingTargetCount,
    retainedAbandonedAttemptCount: () => abandonedAttempts.size,
    retainedDesiredTargetCount: () => retainedDesiredTargetCount,
  };
}
