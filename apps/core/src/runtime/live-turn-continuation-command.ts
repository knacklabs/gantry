import type {
  LiveTurnCommand,
  LiveTurnCoordinationRepository,
  LiveTurnLeaseFence,
} from '../domain/ports/live-turns.js';
import type { LiveTurnCommandApplyResult } from './live-turn-command-pump.js';
import type { LiveTurnLocalRunnerHooks } from './live-turn-authority.js';

export async function applyLiveContinuationCommand(
  command: LiveTurnCommand,
  registration:
    | {
        hooks: LiveTurnLocalRunnerHooks | null;
        runId: string;
        fence: LiveTurnLeaseFence;
      }
    | undefined,
  liveTurns: Pick<
    LiveTurnCoordinationRepository,
    'releaseInput' | 'markLiveTurnCommandRejected'
  >,
): Promise<LiveTurnCommandApplyResult> {
  const hooks = registration?.hooks;
  if (!hooks) return 'retry';
  const text =
    typeof command.payload.text === 'string' ? command.payload.text : null;
  if (!text) return 'rejected';
  const threadId =
    typeof command.payload.threadId === 'string'
      ? command.payload.threadId
      : null;
  if (!hooks.applyContinuation({ text, sequence: command.seq, threadId })) {
    await liveTurns.releaseInput({
      consumedBy: `turn:${registration.runId}/command:${command.id}`,
    });
    const rejected = await liveTurns.markLiveTurnCommandRejected({
      id: command.id,
      reason: 'Runner no longer accepts this continuation.',
      fence: registration.fence,
    });
    return rejected ? 'rejected' : 'retry';
  }
  hooks.onContinuationApplied?.();
  return 'applied';
}
