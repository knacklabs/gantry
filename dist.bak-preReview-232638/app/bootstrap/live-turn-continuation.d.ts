import type { NewMessage } from '../../domain/types.js';
import type { LiveTurnCommand, LiveTurnCommandRepository, LiveTurnLeaseFence } from '../../domain/ports/live-turns.js';
export declare function buildLiveTurnContinuation(input: {
    queueJid: string;
    sinceCursor?: string;
    messages: readonly NewMessage[] | undefined;
    timezone: string;
    onRouted?: () => Promise<void> | void;
    setAgentCursor?: (queueJid: string, cursor: string) => void;
    saveState?: () => Promise<void> | void;
}): {
    text: string;
    senderUserIds: readonly string[];
    idempotencyKey: string;
    cursorAfter: string;
    onRouted: () => Promise<void> | void;
} | null;
export declare function latestPendingContinuationCursor(commands: readonly LiveTurnCommand[]): string | null;
export declare function markPendingContinuationCommandsApplied(input: {
    liveTurns: Pick<LiveTurnCommandRepository, 'markLiveTurnCommandApplied'>;
    commands: readonly LiveTurnCommand[];
    fence: LiveTurnLeaseFence;
}): Promise<void>;
