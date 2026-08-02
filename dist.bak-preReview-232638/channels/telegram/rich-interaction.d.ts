import type { RichInteractionRequest } from '../../domain/types.js';
export declare function renderTelegramRichInteractionHtml(input: RichInteractionRequest): {
    text: string;
    reply_markup?: Record<string, unknown>;
};
export declare function renderTelegramRichInteraction(input: {
    bot: any;
    jid: string;
    render: RichInteractionRequest;
    sendFallback: (text: string, options: {
        threadId?: string;
    }) => Promise<unknown>;
}): Promise<boolean>;
