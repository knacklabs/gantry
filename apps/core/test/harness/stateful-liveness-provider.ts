import type { ChannelAdapter } from '@core/channels/channel-provider.js';
import { LiveUxRateLimitError } from '@core/domain/channel-live-ux.js';
import type { ProgressUpdateOptions } from '@core/domain/types.js';

type MutationKind = 'progress' | 'reaction' | 'typing';

type DeferredMutation = {
  promise: Promise<void>;
  release(): void;
};

export type StatefulLivenessProviderOptions = {
  name?: string;
  ownsJid?: (jid: string) => boolean;
  progressState?: StatefulLivenessProgressState;
  reactionRemoval?: 'exact' | 'all';
  typing?: 'none' | 'expiring' | 'explicit';
};

export type StatefulLivenessProgressState = {
  cards: Map<string, { jid: string; text: string }>;
  cardIdByRoute: Map<string, string>;
};

export function createStatefulLivenessProgressState(): StatefulLivenessProgressState {
  return {
    cards: new Map(),
    cardIdByRoute: new Map(),
  };
}

export class StatefulLivenessProvider {
  readonly cards: Map<string, { jid: string; text: string }>;
  readonly reactions = new Map<string, Set<string>>();
  readonly typing = new Map<string, boolean>();
  readonly reactionHistory: Array<{
    operation: 'add' | 'remove';
    jid: string;
    messageRef: string;
    emoji: string;
    threadId?: string;
  }> = [];
  readonly typingHistory: Array<{
    jid: string;
    isTyping: boolean;
    threadId?: string;
  }> = [];
  readonly attempts = { progress: 0, reaction: 0, typing: 0 };
  readonly adapter: ChannelAdapter;
  maxMutationsInFlight = 0;

  private readonly cardIdByRoute: Map<string, string>;
  private mutationsInFlight = 0;
  private nextFailure: unknown;
  private nextDelay: Promise<void> | undefined;

  constructor(options: StatefulLivenessProviderOptions = {}) {
    const progressState =
      options.progressState ?? createStatefulLivenessProgressState();
    this.cards = progressState.cards;
    this.cardIdByRoute = progressState.cardIdByRoute;
    const reactionRemoval = options.reactionRemoval ?? 'exact';
    const ownsJid = options.ownsJid ?? (() => true);
    this.adapter = {
      name: options.name ?? 'stateful-liveness',
      connect: async () => undefined,
      disconnect: async () => undefined,
      isConnected: () => true,
      ownsJid,
      sendMessage: async () => undefined,
      liveUx: {
        typing: options.typing ?? 'expiring',
        reactions: { removal: reactionRemoval },
        canonicalTarget: (target) => ({
          key:
            target.operation === 'typing'
              ? this.routeKey(target.jid, target.threadId)
              : this.reactionKey(
                  target.jid,
                  target.messageRef,
                  target.threadId,
                  reactionRemoval === 'exact' ? target.emoji : undefined,
                ),
        }),
      },
      setTyping: async (jid, isTyping, mutationOptions) => {
        await this.mutate('typing', () => {
          this.typingHistory.push({
            jid,
            isTyping,
            ...(mutationOptions?.threadId
              ? { threadId: mutationOptions.threadId }
              : {}),
          });
          this.typing.set(
            this.routeKey(jid, mutationOptions?.threadId),
            isTyping,
          );
        });
      },
      addReaction: async (jid, messageRef, emoji, mutationOptions) => {
        await this.mutate('reaction', () => {
          this.reactionHistory.push({
            operation: 'add',
            jid,
            messageRef,
            emoji,
            ...(mutationOptions?.threadId
              ? { threadId: mutationOptions.threadId }
              : {}),
          });
          const key = this.reactionKey(
            jid,
            messageRef,
            mutationOptions?.threadId,
          );
          if (reactionRemoval === 'all') {
            this.reactions.set(key, new Set([emoji]));
            return;
          }
          const current = this.reactions.get(key) ?? new Set<string>();
          current.add(emoji);
          this.reactions.set(key, current);
        });
      },
      removeReaction: async (jid, messageRef, emoji, mutationOptions) => {
        await this.mutate('reaction', () => {
          this.reactionHistory.push({
            operation: 'remove',
            jid,
            messageRef,
            emoji,
            ...(mutationOptions?.threadId
              ? { threadId: mutationOptions.threadId }
              : {}),
          });
          const key = this.reactionKey(
            jid,
            messageRef,
            mutationOptions?.threadId,
          );
          if (reactionRemoval === 'all') {
            this.reactions.delete(key);
            return;
          }
          const current = this.reactions.get(key);
          current?.delete(emoji);
          if (current?.size === 0) this.reactions.delete(key);
        });
      },
      progressCardIdentity: (jid, progressOptions) =>
        this.cardIdByRoute.get(this.routeKey(jid, progressOptions?.threadId)),
      sendProgressUpdate: (jid, text, progressOptions) =>
        this.sendProgressUpdate(jid, text, progressOptions),
    };
  }

  failNext(error: unknown = new Error('Injected provider failure')): void {
    this.nextFailure = error;
  }

  rateLimitNext(retryDelayMs = 1): void {
    this.failNext(
      new LiveUxRateLimitError(retryDelayMs, new Error('Injected rate limit')),
    );
  }

  delayNext(): DeferredMutation {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextDelay = promise;
    return { promise, release };
  }

  reactionSet(jid: string, messageRef: string, threadId?: string): Set<string> {
    return new Set(
      this.reactions.get(this.reactionKey(jid, messageRef, threadId)) ?? [],
    );
  }

  cardTexts(): string[] {
    return [...this.cards.values()].map((card) => card.text);
  }

  snapshotProgressState(): StatefulLivenessProgressState {
    return {
      cards: new Map(
        [...this.cards].map(([messageId, card]) => [messageId, { ...card }]),
      ),
      cardIdByRoute: new Map(this.cardIdByRoute),
    };
  }

  private async sendProgressUpdate(
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<boolean> {
    return this.mutate('progress', () => {
      const routeKey = this.routeKey(jid, options?.threadId);
      const requestedMessageId = options?.progressCardIdentity;
      if (requestedMessageId) {
        const existing = this.cards.get(requestedMessageId);
        if (
          !existing ||
          this.cardIdByRoute.get(routeKey) !== requestedMessageId
        ) {
          return false;
        }
        this.cards.set(requestedMessageId, { jid, text });
        return true;
      }

      if (options?.replaceOnly) return false;
      const messageId = `message-${this.cards.size + 1}`;
      this.cardIdByRoute.set(routeKey, messageId);
      this.cards.set(messageId, { jid, text });
      return true;
    });
  }

  private async mutate<T>(kind: MutationKind, apply: () => T): Promise<T> {
    this.attempts[kind] += 1;
    this.mutationsInFlight += 1;
    this.maxMutationsInFlight = Math.max(
      this.maxMutationsInFlight,
      this.mutationsInFlight,
    );
    const delay = this.nextDelay;
    const failure = this.nextFailure;
    this.nextDelay = undefined;
    this.nextFailure = undefined;
    try {
      await delay;
      if (failure) throw failure;
      return apply();
    } finally {
      this.mutationsInFlight -= 1;
    }
  }

  private routeKey(jid: string, threadId?: string): string {
    return `${jid}\n${threadId ?? ''}`;
  }

  private reactionKey(
    jid: string,
    messageRef: string,
    threadId?: string,
    emoji?: string,
  ): string {
    return `${this.routeKey(jid, threadId)}\n${messageRef}${emoji ? `\n${emoji}` : ''}`;
  }
}
