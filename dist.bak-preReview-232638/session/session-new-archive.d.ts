export type SessionArchiveFinalizer = () => Promise<void>;
export type PrepareSessionArchive = (cause: 'new-session') => Promise<SessionArchiveFinalizer | undefined> | SessionArchiveFinalizer | undefined;
export declare function prepareNewSessionArchive(input: {
    groupName: string;
    logger: {
        warn(payload: unknown, message: string): void;
    };
    prepareSessionArchive?: PrepareSessionArchive;
    archiveCurrentSession: (cause: 'new-session') => Promise<unknown>;
}): Promise<SessionArchiveFinalizer | undefined>;
export declare function runNewSessionArchiveFinalizer(input: {
    groupName: string;
    logger: {
        warn(payload: unknown, message: string): void;
    };
    finalizeArchive?: SessionArchiveFinalizer;
    onSessionArchived?: (cause: 'new-session') => Promise<void>;
}): void;
