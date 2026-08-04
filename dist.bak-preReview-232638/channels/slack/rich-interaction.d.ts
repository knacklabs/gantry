import type { RichInteractionRequest } from '../../domain/types.js';
export declare function buildSlackRichInteractionBlocks(input: RichInteractionRequest): Array<Record<string, unknown>>;
export declare function renderSlackRichInteraction(input: {
    app: any;
    jid: string;
    channelId: string;
    render: RichInteractionRequest;
    pendingRichForms: Map<string, RichInteractionRequest>;
    sendFallback: (text: string, options: {
        threadId?: string;
    }) => Promise<unknown>;
}): Promise<boolean>;
export declare function registerSlackRichFormHandlers(input: {
    app: any;
    pendingRichForms: Map<string, RichInteractionRequest>;
}): void;
