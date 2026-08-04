import { type RuntimeSignalPumpDeps } from '../../../../runner/runtime-signal-pump.js';
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
export declare function startDeepAgentLiveControl(options?: {
    pollMs?: number;
    log?: (message: string) => void;
    deps?: RuntimeSignalPumpDeps;
}): DeepAgentLiveControl;
export declare function isAbortError(error: unknown): boolean;
