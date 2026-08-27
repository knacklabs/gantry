function mutationKey(routeKey: string, progressKey: string): string {
  return JSON.stringify([routeKey, progressKey]);
}

const DISCORD_PROGRESS_PROVIDER_DEADLINE_MS = 45_000;
const DISCORD_PROGRESS_PROVIDER_ABORT_GRACE_MS = 5_000;
export const DISCORD_PROGRESS_PROVIDER_SETTLEMENT_WINDOW_MS =
  DISCORD_PROGRESS_PROVIDER_DEADLINE_MS +
  DISCORD_PROGRESS_PROVIDER_ABORT_GRACE_MS;

type Mutation = (
  signal: AbortSignal,
  isAbandoned: () => boolean,
) => Promise<boolean>;

type QueuedMutation = {
  mutation: Mutation;
  resolve: (accepted: boolean) => void;
  reject: (error: unknown) => void;
};

export class DiscordProgressMutationQueue {
  readonly pendingByProgressKey = new Map<string, Promise<void>>();

  private queuedByProgressKey = new Map<string, QueuedMutation>();
  private releaseAfterSettlementByProgressKey = new Set<string>();

  enqueue(
    routeKey: string,
    progressKey: string,
    mutation: Mutation,
  ): Promise<boolean> {
    const key = mutationKey(routeKey, progressKey);
    if (this.pendingByProgressKey.has(key)) {
      this.queuedByProgressKey.get(key)?.resolve(true);
      return new Promise<boolean>((resolve, reject) => {
        this.queuedByProgressKey.set(key, { mutation, resolve, reject });
      });
    }
    return this.launch(key, mutation);
  }

  releaseKey(key: string): void {
    if (this.pendingByProgressKey.has(key)) {
      this.releaseAfterSettlementByProgressKey.add(key);
      return;
    }
    this.clearKey(key);
  }

  private launch(key: string, mutation: Mutation): Promise<boolean> {
    const controller = new AbortController();
    let abandoned = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      abortTimer = setTimeout(() => {
        controller.abort(new Error('Discord progress mutation timed out'));
        graceTimer = setTimeout(() => {
          abandoned = true;
          reject(
            new Error(
              'Discord progress mutation did not settle after abort grace',
            ),
          );
        }, DISCORD_PROGRESS_PROVIDER_ABORT_GRACE_MS);
        graceTimer.unref?.();
      }, DISCORD_PROGRESS_PROVIDER_DEADLINE_MS);
      abortTimer.unref?.();
    });
    // Provider callbacks must honor AbortSignal. The grace race keeps a
    // non-conforming callback from permanently owning this key; its eventual
    // settlement is observed by Promise.race but cannot settle this queue slot.
    let mutationResult: Promise<boolean>;
    try {
      mutationResult = mutation(controller.signal, () => abandoned);
    } catch (error) {
      mutationResult = Promise.reject(error);
    }
    const result = Promise.race([mutationResult, deadline]).finally(() => {
      if (abortTimer) clearTimeout(abortTimer);
      if (graceTimer) clearTimeout(graceTimer);
    });
    const pending = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.pendingByProgressKey.get(key) !== pending) return;
        const queued = this.queuedByProgressKey.get(key);
        if (queued) {
          this.queuedByProgressKey.delete(key);
          void this.launch(key, queued.mutation).then(
            queued.resolve,
            queued.reject,
          );
          return;
        }
        this.pendingByProgressKey.delete(key);
        if (this.releaseAfterSettlementByProgressKey.delete(key)) {
          this.clearKey(key);
        }
      });
    this.pendingByProgressKey.set(key, pending);
    return result;
  }

  private clearKey(key: string): void {
    this.pendingByProgressKey.delete(key);
    this.queuedByProgressKey.delete(key);
    this.releaseAfterSettlementByProgressKey.delete(key);
  }
}
