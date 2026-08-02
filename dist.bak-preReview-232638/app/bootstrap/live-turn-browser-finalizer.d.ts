type WarnLog = (context: Record<string, unknown>, message: string) => void;
export interface LiveTurnBrowserFinalizer {
    (input: {
        queueJid: string;
        runId?: string | null;
        fencingVersion?: number;
    }): Promise<void>;
}
export declare function buildLiveTurnBrowserFinalizer(deps: {
    getConversationRoutes: () => Record<string, {
        folder: string;
    }>;
    closeBrowserSession?: (profileName: string) => Promise<unknown>;
    closeBrowserToolBackends?: (profileName: string) => Promise<void>;
    warn: WarnLog;
}): LiveTurnBrowserFinalizer;
export {};
