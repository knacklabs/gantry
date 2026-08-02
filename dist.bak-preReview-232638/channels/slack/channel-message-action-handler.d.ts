import type { OnMessageAction } from '../../domain/types.js';
type SlackAppLike = {
    action: (name: string, handler: (args: any) => Promise<void>) => void;
    client: {
        chat: {
            postEphemeral: (input: any) => Promise<unknown>;
        };
    };
};
export declare function registerSlackMessageActionHandler(app: SlackAppLike, opts?: {
    onMessageAction?: OnMessageAction;
    providerAccountId?: string;
}): void;
export {};
