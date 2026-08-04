type TelegramMediaQueue = {
    enqueue(task: () => Promise<void>): boolean;
    enqueueWhenAvailable(task: () => Promise<void>): Promise<boolean>;
    size(): number;
};
export declare function registerTelegramMediaHandlers(input: {
    bot: any;
    opts: {
        onChatMetadata: (jid: string, timestamp: string, name: string | undefined, provider: 'telegram', isGroup: boolean, options?: {
            providerAccountId?: string;
        }) => Promise<void>;
        providerAccountId?: string;
        onMessage: (jid: string, message: any) => Promise<void>;
        ensureMessageRoute?: (jid: string, message: any) => Promise<unknown>;
        conversationRoutes: () => Record<string, {
            folder: string;
            name?: string | null;
            trigger?: string | null;
        }>;
    };
    mediaIngestionQueue: TelegramMediaQueue;
    downloadFile: (fileId: string, folder: string, filename: string) => Promise<{
        storageRef: string;
    } | null>;
    sanitizeErrorMessage: (err: unknown) => unknown;
}): void;
export {};
