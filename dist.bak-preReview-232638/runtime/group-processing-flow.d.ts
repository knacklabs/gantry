import type { FinalProgressState } from './progress-updates.js';
type GroupTurnRunResult = 'success' | 'error' | 'stopped';
export declare function handleFailure(input: {
    outputSentToUser: boolean;
    acknowledgeFailedTurn?: boolean;
    preserveCursor?: boolean;
    groupName: string;
    queueJid: string;
    previousCursor: string;
    deps: {
        setCursor: (chatJid: string, timestamp: string) => void;
        saveState: () => Promise<void> | void;
    };
    logger: {
        warn(payload: Record<string, unknown>, message: string): void;
    };
}): Promise<boolean>;
export declare function resetGroupStreamingForTurn(input: {
    chatJid: string;
    groupName: string;
    channelRuntime: {
        resetStreaming(jid: string, options?: {
            providerAccountId?: string;
        }): void;
    };
    providerAccountId?: string;
    logger: {
        debug(payload: Record<string, unknown>, message: string): void;
    };
}): void;
export declare function waitOutput(input: {
    wait: () => Promise<void>;
    getError: () => unknown;
    hadError: boolean;
    groupName: string;
    logger: {
        error(payload: Record<string, unknown>, message: string): void;
    };
}): Promise<boolean>;
export declare function resolveGroupTurnFinalProgressState(input: {
    output: GroupTurnRunResult;
    hadError: boolean;
    sawDeliveryIncomplete: boolean;
    sawTerminalDeliveryFailure: boolean;
    outputSentToUser: boolean;
}): FinalProgressState;
export declare function shouldSendTurnFinalProgress(input: {
    finalProgressState: FinalProgressState;
    awaitingResponseReceipt: boolean;
    sentAnyTurnDoneProgress: boolean;
    activeGenerationHasOutput: boolean;
    sentTurnDoneProgressGeneration: number | null;
    progressGeneration: number;
}): boolean;
export {};
