export interface LiveUxOperationOptions {
  threadId?: string;
  signal?: AbortSignal;
  reconcile?: boolean;
  resolvedTarget?: unknown;
}

export type LiveUxCanonicalTarget =
  | { operation: 'typing'; jid: string; threadId?: string }
  | {
      operation: 'reaction';
      jid: string;
      threadId?: string;
      messageRef: string;
      emoji: string;
    };

export interface MessageReactionSink {
  addReaction(
    jid: string,
    messageRef: string,
    emoji: string,
    options?: LiveUxOperationOptions,
  ): Promise<void>;
}

export interface MessageReactionRemovalSink {
  removeReaction: MessageReactionSink['addReaction'];
}

export interface TypingSink {
  setTyping(
    jid: string,
    isTyping: boolean,
    options?: LiveUxOperationOptions,
  ): Promise<void>;
}

export interface ChannelLiveUxCapability {
  typing: 'none' | 'expiring' | 'explicit';
  reactions: 'none' | { removal: 'exact' | 'all' };
  canonicalTarget(target: LiveUxCanonicalTarget): {
    key: string;
    resolvedTarget?: unknown;
  };
}

export class LiveUxRateLimitError extends Error {
  readonly name = 'LiveUxRateLimitError';

  constructor(
    readonly retryDelayMs: number,
    readonly cause: unknown,
  ) {
    super('Live UX delivery rate-limited');
  }
}
