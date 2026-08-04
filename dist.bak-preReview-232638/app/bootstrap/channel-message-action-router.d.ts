import type { OnMessageAction, ProgressUpdateOptions } from '../../domain/types.js';
export declare function createChannelMessageActionRouter(): {
    handle: OnMessageAction;
    trackProgress: (conversationJid: string, options?: ProgressUpdateOptions) => void;
    set: (handler: OnMessageAction | undefined) => void;
};
