import type {
  LiveTurnCommand,
  LiveTurnCommandRepository,
  LiveTurnCommandType,
  LiveTurnLeaseFence,
} from '../domain/ports/live-turns.js';

/**
 * Owner-side consumer of the durable live-turn command inbox. The owning
 * worker drains pending commands in sequence order and applies each one to
 * its local runner (IPC continuation write, stdin close, stop signal).
 * Apply marking happens after the local side effect succeeds and is fenced by
 * the owner's run lease.
 */

/**
 * Handler failure leaves the command pending so recovery can replay it under a
 * live owner instead of losing already-advanced channel input.
 */
export type LiveTurnCommandApplyResult = 'applied' | 'rejected' | 'retry';

export type LiveTurnCommandHandler = (
  command: LiveTurnCommand,
) => Promise<LiveTurnCommandApplyResult> | LiveTurnCommandApplyResult;

export type LiveTurnCommandHandlers = Partial<
  Record<LiveTurnCommandType, LiveTurnCommandHandler>
>;

export interface LiveTurnCommandPump {
  /** Drain pending commands once; resolves to the number applied. */
  drain(): Promise<number>;
}

export function createLiveTurnCommandPump(input: {
  liveTurns: Pick<
    LiveTurnCommandRepository,
    | 'listPendingLiveTurnCommands'
    | 'isLiveTurnCommandFenceActive'
    | 'markLiveTurnCommandApplied'
    | 'markLiveTurnCommandRejected'
  >;
  turnId: string;
  fence: LiveTurnLeaseFence;
  handlers: LiveTurnCommandHandlers;
  canApplyCommand?: (command: LiveTurnCommand) => boolean;
  batchLimit?: number;
  onError?: (err: unknown, command: LiveTurnCommand) => void;
}): LiveTurnCommandPump {
  const batchLimit = Math.max(1, input.batchLimit ?? 32);
  // Serialized tail: every drain() request chains a drainOnce that is
  // guaranteed to start after the request, so a command appended right
  // before drain() is always observed. The tail never rejects.
  let tail: Promise<number> = Promise.resolve(0);

  async function drainOnce(): Promise<number> {
    let appliedCount = 0;
    for (;;) {
      const pending = await input.liveTurns.listPendingLiveTurnCommands({
        liveTurnId: input.turnId,
        limit: batchLimit,
      });
      if (pending.length === 0) return appliedCount;
      for (const command of pending) {
        if (input.canApplyCommand && !input.canApplyCommand(command)) {
          return appliedCount;
        }
        const handler = input.handlers[command.commandType];
        if (!handler) {
          const marked = await input.liveTurns.markLiveTurnCommandRejected({
            id: command.id,
            reason: `unsupported command type: ${command.commandType}`,
            fence: input.fence,
          });
          if (!marked) return appliedCount;
          continue;
        }
        const fenceActive = await input.liveTurns.isLiveTurnCommandFenceActive({
          id: command.id,
          fence: input.fence,
        });
        if (!fenceActive) return appliedCount;
        let result: LiveTurnCommandApplyResult;
        try {
          result = await handler(command);
        } catch (err) {
          input.onError?.(err, command);
          return appliedCount;
        }
        if (result !== 'applied') {
          input.onError?.(
            new Error(`live-turn command handler returned ${result}`),
            command,
          );
          return appliedCount;
        }
        const marked = await input.liveTurns.markLiveTurnCommandApplied({
          id: command.id,
          appliedByWorkerId: input.fence.workerInstanceId,
          fence: input.fence,
        });
        if (!marked) return appliedCount;
        appliedCount += 1;
      }
      if (pending.length < batchLimit) return appliedCount;
    }
  }

  function drain(): Promise<number> {
    const next = tail.then(() => drainOnce());
    // Keep the tail resilient: a failed drainOnce must not poison later
    // drains. Callers still observe the failure on their own `next`.
    tail = next.then(
      () => 0,
      () => 0,
    );
    return next;
  }

  return { drain };
}
