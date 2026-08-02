import { type RuntimeEventType } from '../domain/events/runtime-event-types.js';
export declare const FORWARDED_RUNNER_EVENT_TYPES: Set<RuntimeEventType>;
export interface JobRunDiagnostics {
    lastHeartbeat?: Record<string, unknown>;
    currentTool?: string;
    lastTool?: string;
    pendingPermissionRequests: number;
    pendingPermissionToolNames: string[];
    totalToolCalls: number;
    browserActivityCount: number;
    transientPermissionApprovals: Array<{
        toolName: string;
        mode: string;
        recoveryAction?: string;
    }>;
    startupDiagnostics: Record<string, unknown>[];
    latestStreamedOutputChars: number;
    totalStreamedOutputChars: number;
    lastActivityAt?: string;
    lastPermissionWait?: {
        toolName: string;
        reason?: string;
        recoveryAction?: string;
    };
    terminalToolDenial?: {
        toolName: string;
        reason?: string;
        recoveryAction?: string;
    };
}
export declare function toolDenialEventPayload(toolDenial: NonNullable<JobRunDiagnostics['terminalToolDenial']>, safeErrorSummary: string | null): Record<string, unknown>;
export interface StreamingEventFlusher {
    append(chars: number): void;
    flush(force?: boolean): void;
}
/** Throttled JOB_STREAMING progress events (at most one per second). */
export declare function createStreamingEventFlusher(input: {
    nowMs: () => number;
    emit: (payload: {
        buffered_chars: number;
        total_chars: number;
    }) => Promise<unknown> | unknown;
}): StreamingEventFlusher;
export declare function createJobRunDiagnostics(): JobRunDiagnostics;
export declare function updateDiagnosticsFromRuntimeEvent(diagnostics: JobRunDiagnostics, eventType: RuntimeEventType, payload: Record<string, unknown>): void;
export declare function forwardRunnerRuntimeEvents(input: {
    events?: readonly {
        eventType: unknown;
        payload?: unknown;
    }[];
    diagnostics: JobRunDiagnostics;
    emitJobEvent: (eventType: RuntimeEventType, payload: Record<string, unknown>) => Promise<void>;
}): Promise<void>;
export declare function runnerRuntimeEventKey(event: {
    eventType: unknown;
    payload?: unknown;
}): string | undefined;
export declare function filterUnforwardedRunnerRuntimeEvents(events: Array<{
    eventType: unknown;
    payload?: unknown;
}> | undefined, forwardedKeys: Set<string>): Array<{
    eventType: unknown;
    payload?: unknown;
}> | undefined;
export declare function terminalDiagnosticsPayload(diagnostics: JobRunDiagnostics): Record<string, unknown>;
export declare function formatTerminalDiagnostics(diagnostics: JobRunDiagnostics): string;
export declare function formatTerminalToolDenial(diagnostics: JobRunDiagnostics): string | undefined;
export declare function toolAccessRequirementsIncludeBrowser(toolAccessRequirements: readonly string[]): boolean;
