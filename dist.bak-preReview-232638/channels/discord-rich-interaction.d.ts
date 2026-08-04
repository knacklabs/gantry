import type { RichInteractionRequest } from '../domain/types.js';
export declare const DISCORD_RICH_FORM_OPEN_PREFIX = "gantry:rich_form_open:";
export declare function buildDiscordRichInteractionPayload(input: RichInteractionRequest): {
    content: string;
    embeds: unknown[];
    components?: unknown[];
};
export declare function buildDiscordRichInteractionFormModalResponse(input: RichInteractionRequest): Record<string, unknown>;
export declare function renderDiscordRichInteraction(input: {
    jid: string;
    channelId: string | null;
    render: RichInteractionRequest;
    richForms: Map<string, RichInteractionRequest>;
    postMessage: (channelId: string, body: Record<string, unknown>) => Promise<unknown>;
    sendFallback: (text: string, options: {
        threadId?: string;
    }) => Promise<unknown>;
}): Promise<boolean>;
export declare function openDiscordRichFormInteraction(input: {
    apiRoot: string;
    headers: Record<string, string>;
    interaction: {
        id?: string;
        token?: string;
    };
    customId: string;
    richForms: Map<string, RichInteractionRequest>;
    ackInteraction: (message: string) => Promise<void>;
}): Promise<void>;
