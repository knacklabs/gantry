import type { MessageDeliveryResult, MessageFileAttachment } from '../domain/types.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
export type DiscordMessagePoster = (channelId: string, body: Record<string, unknown>) => Promise<{
    id?: string;
}>;
export declare function splitDiscordText(text: string): string[];
export declare function formatDiscordAgentTodo(render: AgentTodoRender): string;
export declare function postDiscordMessageParts(input: {
    channelId: string;
    parts: string[];
    components?: unknown[];
    files?: MessageFileAttachment[];
    apiRoot?: string;
    botToken?: string;
    post: DiscordMessagePoster;
    shouldContinue?: () => boolean;
}): Promise<MessageDeliveryResult>;
