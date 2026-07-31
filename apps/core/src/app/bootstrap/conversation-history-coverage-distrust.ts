import type { ProviderAccountId } from '../../domain/provider/provider.js';
import type { ConversationHistoryCoverageRepository } from '../../domain/ports/conversation-history-coverage.js';
import type { logger } from '../../infrastructure/logging/logger.js';

const INITIAL_RETRY_MS = 100;
export const HISTORY_COVERAGE_DISTRUST_MAX_RETRY_MS = 2_000;

export interface ConversationHistoryDistrustEpoch {
  readonly current: number;
  readonly durable: number;
}

interface ProviderDistrustState extends ConversationHistoryDistrustEpoch {
  worker?: Promise<void>;
}

export class ConversationHistoryCoverageDistrust {
  private readonly epochs = new Map<string, ProviderDistrustState>();

  constructor(
    private readonly repository: () => ConversationHistoryCoverageRepository,
    private readonly runtimeLogger: Pick<typeof logger, 'warn'>,
  ) {}

  readEpoch(providerAccountId: string): ConversationHistoryDistrustEpoch {
    const epoch = this.epochs.get(providerAccountId);
    return epoch
      ? { current: epoch.current, durable: epoch.durable }
      : { current: 0, durable: 0 };
  }

  readonly distrust = (providerAccountIds: readonly string[]): void => {
    for (const providerAccountId of providerAccountIds) {
      const state = this.epochs.get(providerAccountId);
      const previous = state ?? { current: 0, durable: 0 };
      const current = previous.current + 1;
      this.epochs.set(providerAccountId, {
        current,
        durable: previous.durable,
        worker: state?.worker,
      });
      this.ensureWorker(providerAccountId);
    }
  };

  private ensureWorker(providerAccountId: string): void {
    const state = this.epochs.get(providerAccountId);
    if (!state || state.worker) return;

    const worker = this.bumpUntilDurable(providerAccountId);
    state.worker = worker;
    void worker
      .catch((err) => {
        this.runtimeLogger.warn(
          { err, providerAccountId },
          'Conversation history coverage invalidation stopped unexpectedly',
        );
      })
      .finally(() => {
        const latest = this.epochs.get(providerAccountId);
        if (!latest || latest.worker !== worker) return;
        latest.worker = undefined;
        if (latest.durable < latest.current)
          this.ensureWorker(providerAccountId);
      });
  }

  private async bumpUntilDurable(providerAccountId: string): Promise<void> {
    let retryMs = INITIAL_RETRY_MS;
    for (;;) {
      const requestedEpoch = this.readEpoch(providerAccountId).current;
      try {
        await this.repository().bumpProviderGeneration(
          providerAccountId as ProviderAccountId,
        );
        const current = this.readEpoch(providerAccountId);
        this.epochs.set(providerAccountId, {
          current: current.current,
          durable: Math.max(current.durable, requestedEpoch),
          worker: this.epochs.get(providerAccountId)?.worker,
        });
        if (current.current <= requestedEpoch) return;
        retryMs = INITIAL_RETRY_MS;
      } catch (err) {
        this.runtimeLogger.warn(
          { err, providerAccountId, retryMs },
          'Conversation history coverage invalidation failed; retrying in background',
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryMs);
          timer.unref?.();
        });
        retryMs = Math.min(HISTORY_COVERAGE_DISTRUST_MAX_RETRY_MS, retryMs * 2);
      }
    }
  }
}

// Residual risk: a cross-process turn immediately after DB recovery may trust
// stale coverage for at most the retry cap. Single-process deployments are
// fully closed by the synchronous epoch; otherwise stale trust still requires
// a successful DB read, which implies the background retry lands.
