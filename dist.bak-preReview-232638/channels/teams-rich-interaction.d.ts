import type { RichInteractionRequest } from '../domain/types.js';
import { type TeamsSdkClient } from './teams-types.js';
export declare function buildTeamsRichInteractionPayload(input: RichInteractionRequest): {
    attachments: [{
        contentType: string;
        content: Record<string, unknown>;
    }];
};
export declare function renderTeamsRichInteraction(input: {
    sdkClient: TeamsSdkClient;
    jid: string;
    render: RichInteractionRequest;
    sendFallback: (text: string, options: {
        threadId?: string;
    }) => Promise<unknown>;
}): Promise<boolean>;
