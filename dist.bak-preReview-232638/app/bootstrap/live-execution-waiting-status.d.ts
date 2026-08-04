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
export declare const WAITING_STATUS_THRESHOLD_MS = 30000;
/** How often the coordinator probes for waiting live admissions. */
export declare const WAITING_STATUS_POLL_INTERVAL_MS = 5000;
/** The exact user-facing status text. */
export declare const WAITING_STATUS_TEXT = "Still starting this request.";
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
export declare function startWaitingStatusMonitor(input: {
    liveTurns: Pick<LiveTurnCoordinationRepository, 'getOldestWaitingLiveAdmission'>;
    getConversationJids: () => string[];
    sendStatus: (conversationJid: string, text: string) => Promise<void>;
    warn: WarnLog;
    thresholdMs?: number;
    intervalMs?: number;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
}): WaitingStatusMonitorHandle;
export {};
