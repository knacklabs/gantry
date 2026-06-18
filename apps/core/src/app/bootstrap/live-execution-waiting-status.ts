import type { LiveTurnCoordinationRepository } from '../../domain/ports/live-turns.js';

/**
 * Waiting-status UX: "Still starting this request."
 *
 * When the live fleet is saturated, an inbound message is still accepted
 * durably (WP2 message-store cursor guarantees retry — nothing is lost), but the
 * user sees nothing. This sibling timer of the recovery COORDINATOR (a singleton)
 * periodically asks the durable store for the oldest live message that arrived
 * but was never picked up by a turn. Dedupe is per-coordinator-tenure: across a
 * lease failover the successor coordinator starts with an empty notified set, so
 * a still-waiting conversation can be re-sent the status once (bounded,
 * transient, accepted). When that
 * age crosses {@link WAITING_STATUS_THRESHOLD_MS}, it sends the visible status to
 * that conversation ONCE per waiting episode. An episode is one continuous span
 * of waiting; it resets as soon as that conversation stops appearing in the
 * waiting query (its message was admitted), so a later backlog re-notifies.
 *
 * Delivery uses the transient progress-update path (same durability level as
 * other live progress/status updates) — a transient status must not be made
 * durable.
 */

/** A live message waiting longer than this triggers the visible status. */
export const WAITING_STATUS_THRESHOLD_MS = 30_000;

/** How often the coordinator probes for waiting live admissions. */
export const WAITING_STATUS_POLL_INTERVAL_MS = 5_000;

/** The exact user-facing status text. */
export const WAITING_STATUS_TEXT = 'Still starting this request.';

export interface WaitingStatusMonitorHandle {
  /** Stop the probe timer (drain / coordinator lease loss). */
  stop: () => void;
  /**
   * Age in seconds of the oldest currently-waiting live admission across the
   * cluster (0 when none). Read by `/metrics` for `gantry_live_oldest_waiting_seconds`.
   */
  oldestWaitingSeconds: () => number;
}

type WarnLog = (context: Record<string, unknown>, message: string) => void;

export function startWaitingStatusMonitor(input: {
  liveTurns: Pick<
    LiveTurnCoordinationRepository,
    'getOldestWaitingLiveAdmission'
  >;
  getConversationJids: () => string[];
  sendStatus: (conversationJid: string, text: string) => Promise<void>;
  warn: WarnLog;
  thresholdMs?: number;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): WaitingStatusMonitorHandle {
  const thresholdMs = input.thresholdMs ?? WAITING_STATUS_THRESHOLD_MS;
  const intervalMs = input.intervalMs ?? WAITING_STATUS_POLL_INTERVAL_MS;
  const setIntervalFn = input.setIntervalFn ?? setInterval;
  const clearIntervalFn = input.clearIntervalFn ?? clearInterval;

  // Per-conversation episode dedupe: a conversation in this set has already been
  // told it is waiting in the current continuous episode. Cleared the moment it
  // stops being the oldest waiter (admitted), so a later backlog re-notifies.
  const notifiedConversations = new Set<string>();
  let oldestWaitingSeconds = 0;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const conversationJids = input.getConversationJids();
      const waiting = await input.liveTurns.getOldestWaitingLiveAdmission({
        conversationJids,
      });
      if (!waiting) {
        oldestWaitingSeconds = 0;
        notifiedConversations.clear();
        return;
      }
      oldestWaitingSeconds = waiting.ageSeconds;
      // The oldest waiter is the only one we resolve per tick; any conversation
      // that is no longer the oldest waiter has either been admitted or is
      // younger, so its episode is reset here.
      for (const jid of [...notifiedConversations]) {
        if (jid !== waiting.conversationJid) notifiedConversations.delete(jid);
      }
      if (waiting.ageSeconds * 1000 < thresholdMs) return;
      if (notifiedConversations.has(waiting.conversationJid)) return;
      notifiedConversations.add(waiting.conversationJid);
      await input.sendStatus(waiting.conversationJid, WAITING_STATUS_TEXT);
    } catch (err) {
      input.warn({ err }, 'Waiting-status probe failed');
    } finally {
      running = false;
    }
  };

  const timer = setIntervalFn(() => void tick(), intervalMs);
  // A maintenance timer must never keep an otherwise-exiting process alive.
  (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();

  return {
    stop: () => clearIntervalFn(timer),
    oldestWaitingSeconds: () => oldestWaitingSeconds,
  };
}
