type SlackAppLike = {
    event: (name: string, handler: (args: any) => Promise<void>) => void;
    shortcut: (name: string, handler: (args: any) => Promise<void>) => void;
    client: {
        views: {
            publish: (input: any) => Promise<unknown>;
            open: (input: any) => Promise<unknown>;
        };
        chat: {
            postEphemeral: (input: any) => Promise<unknown>;
        };
    };
};
export declare function registerSlackUtilityHandlers(app: SlackAppLike): void;
export {};
