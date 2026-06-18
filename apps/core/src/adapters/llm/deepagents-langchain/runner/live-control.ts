import {
  drainIpcInput,
  shouldClose,
} from '../../../../runner/runner-ipc-input.js';

// Live-turn control parity for the DeepAgents lane. Mirrors the Anthropic
// runner's in-flight signal handling (query-loop.ts pollRuntimeSignalsDuringQuery):
//   - a `_close` sentinel (written by the host for both /stop and close-stdin)
//     aborts the in-flight LangGraph stream via AbortSignal so STOP terminates
//     the run promptly instead of waiting for the model turn to finish;
//   - follow-up messages that arrive mid-stream are buffered and surfaced to the
//     caller so the terminal frame can carry `continuedByFollowup` and the turn
//     can be re-run, exactly as the Anthropic steering gate does.
// The host delivery contract (continuation-input.ts) is engine-neutral, so this
// is the runner-side mirror only; no host code needs a DeepAgents branch.

const DEFAULT_POLL_MS = 250;

export interface DeepAgentLiveControl {
  /** AbortSignal to pass into the LangGraph stream so STOP aborts it. */
  readonly signal: AbortSignal;
  /** True once a `_close` sentinel (stop or close-stdin) has been observed. */
  closed(): boolean;
  /** Follow-up messages buffered mid-stream, in arrival order; drains on read. */
  takeBufferedFollowups(): string[];
  /**
   * Force one synchronous disk drain right now, folding any follow-up that
   * landed after the last poll tick into the buffer (and observing a `_close`
   * that landed in the same window). Called immediately before the loop decides
   * to break so a follow-up written between stream-end and the break decision is
   * never orphaned (R4). Safe to call after stop() — it does not reschedule.
   */
  drainNow(): void;
  /** Stops the polling loop. Idempotent. */
  stop(): void;
}

// Starts a polling loop that watches the neutral IPC-input dir while a turn is
// in flight. The loop is unref'd so it never keeps the process alive on its own.
export function startDeepAgentLiveControl(options?: {
  pollMs?: number;
  log?: (message: string) => void;
}): DeepAgentLiveControl {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
  const log = options?.log;
  const controller = new AbortController();
  const buffered: string[] = [];
  let closedFlag = false;
  let stopped = false;

  // One drain+close-check pass over the IPC-input dir. Returns true if a close
  // sentinel was observed (so the caller stops scheduling). Shared by the poll
  // loop and the synchronous drainNow() so the disk-drain semantics never drift.
  const drainOnce = (): boolean => {
    try {
      // Drain follow-ups first so a message queued just before a close sentinel
      // is not lost; mirrors the Anthropic loop ordering (boundaries/messages
      // then close check is interchangeable because both are file-queued).
      for (const text of drainIpcInput(log)) {
        buffered.push(text);
      }
      if (shouldClose()) {
        closedFlag = true;
        log?.('Close sentinel detected during turn; aborting LangGraph stream');
        controller.abort();
        stopped = true;
        return true;
      }
    } catch (err) {
      log?.(
        `live-control poll error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return false;
  };

  const poll = () => {
    if (stopped) return;
    if (drainOnce()) return;
    schedule();
  };

  const timers: ReturnType<typeof setTimeout>[] = [];
  const schedule = () => {
    if (stopped) return;
    const timer = setTimeout(poll, pollMs);
    timer.unref?.();
    timers.push(timer);
  };
  schedule();

  return {
    signal: controller.signal,
    closed: () => closedFlag,
    takeBufferedFollowups: () => buffered.splice(0, buffered.length),
    // A final synchronous drain run by the loop before it decides to break, even
    // if the poll loop already stopped (e.g. after a close). It never
    // reschedules, so it is safe to call post-stop.
    drainNow: () => {
      drainOnce();
    },
    stop: () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

// A LangGraph/AbortController abort surfaces as an AbortError or a "controller is
// already aborted" style rejection. When the turn was intentionally closed, the
// runner treats this as a graceful stop (terminal success frame) rather than an
// error, matching the Anthropic lane where a close ends the turn cleanly.
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return true;
    const message = error.message.toLowerCase();
    return message.includes('abort');
  }
  return false;
}
