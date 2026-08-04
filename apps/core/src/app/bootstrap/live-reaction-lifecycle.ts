const REACTION_FLIP_DELAY_MS = 5_000;

type ReactionTarget = { jid: string; messageRef: string };
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
      await input
        .removeReaction?.(
          current.jid,
          current.messageRef,
          'running',
          input.options,
        )
        .catch(() => undefined);
      await input
        .addReaction?.(current.jid, current.messageRef, 'seen', input.options)
        .catch(() => undefined);
    });
  };

  return {
    onFirstProgress: async (next: ReactionTarget) => {
      if (target) return;
      target = next;
      await input
        .addReaction?.(next.jid, next.messageRef, 'seen', input.options)
        .catch(() => undefined);
      if (settled || !input.removeReaction) return;
      timer = setTimeout(() => {
        timer = null;
        void enqueue(async () => {
          if (settled || !target) return;
          const current = target;
          await input
            .removeReaction?.(
              current.jid,
              current.messageRef,
              'seen',
              input.options,
            )
            .catch(() => undefined);
          if (settled) return;
          await input
            .addReaction?.(
              current.jid,
              current.messageRef,
              'running',
              input.options,
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
