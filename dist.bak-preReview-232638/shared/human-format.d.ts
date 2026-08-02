export interface DurationFormatOptions {
    compactMinutes?: boolean;
}
export declare function formatDuration(ms: number | null | undefined): string;
export interface RunLabelInput {
    id: string;
    shortId?: number | string | null;
    short_id?: number | string | null;
    attempt?: number | string | {
        current?: number;
        total?: number;
    } | null;
    attemptTotal?: number | null;
    attempt_total?: number | null;
    startedAt?: string | Date | null;
    started_at?: string | Date | null;
    nowMs?: number;
}
export declare function formatRunShortId(run: Pick<RunLabelInput, 'id' | 'shortId' | 'short_id'>): string;
export declare function formatRunLabel(run: RunLabelInput): string;
