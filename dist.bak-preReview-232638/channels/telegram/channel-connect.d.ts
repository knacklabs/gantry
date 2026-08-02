import { TelegramChannelPrompts } from './channel-prompts.js';
export declare abstract class TelegramChannelConnect extends TelegramChannelPrompts {
    private clearRestoredProgressActions;
    connect(options?: {
        inbound?: boolean;
        interactionCallbacks?: boolean;
    }): Promise<void>;
}
