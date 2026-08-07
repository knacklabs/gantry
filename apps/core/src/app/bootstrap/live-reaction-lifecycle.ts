const REACTION_FLIP_DELAY_MS = 5_000;

type ReactionTarget = { jid: string; messageRef: string; threadId?: string };
type ReactionOptions =
  | { providerAccountId?: string; threadId?: string }
  | undefined;

export function createLiveReactionLifecycle(input: {
  addReaction?: (
    jid: string,
    messageRef: string,
    emoji: string,
    options?: ReactionOptions,
  ) => Promise<void>;
  removeReaction?: (
    jid: string,
    messageRef: string,
    emoji: string,
    options?: ReactionOptions,
  ) => Promise<void>;
  removalMode?: 'exact' | 'all';
  options?: ReactionOptions;
}) {
  let target: ReactionTarget | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let transition = Promise.resolve();

  const enqueue = (run: () => Promise<void>) => {
    transition = transition.then(run).catch(() => undefined);
    return transition;
  };
  const optionsFor = (current: ReactionTarget): ReactionOptions => {
    const { threadId: _inheritedThreadId, ...baseOptions } =
      input.options ?? {};
    return input.options || current.threadId
      ? {
          ...baseOptions,
          ...(current.threadId ? { threadId: current.threadId } : {}),
        }
      : undefined;
  };
  const restoreSeen = async () => {
    if (settled) {
      await transition;
      return;
    }
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (!target) return;
    const current = target;
    await enqueue(async () => {
      if (input.removalMode === 'exact') {
        await input
          .removeReaction?.(
            current.jid,
            current.messageRef,
            'running',
            optionsFor(current),
          )
          .catch(() => undefined);
      }
      await input
        .addReaction?.(
          current.jid,
          current.messageRef,
          'seen',
          optionsFor(current),
        )
        .catch(() => undefined);
    });
  };

  return {
    onFirstProgress: async (next: ReactionTarget) => {
      if (target) return;
      target = next;
      await input
        .addReaction?.(next.jid, next.messageRef, 'seen', optionsFor(next))
        .catch(() => undefined);
      if (settled || !input.removalMode) return;
      timer = setTimeout(() => {
        timer = null;
        void enqueue(async () => {
          if (settled || !target) return;
          const current = target;
          if (input.removalMode === 'exact') {
            await input
              .removeReaction?.(
                current.jid,
                current.messageRef,
                'seen',
                optionsFor(current),
              )
              .catch(() => undefined);
          }
          if (settled) return;
          await input
            .addReaction?.(
              current.jid,
              current.messageRef,
              'running',
              optionsFor(current),
            )
            .catch(() => undefined);
        });
      }, REACTION_FLIP_DELAY_MS);
      timer.unref?.();
    },
    onFirstVisibleOutput: restoreSeen,
    onTerminal: restoreSeen,
  };
}
