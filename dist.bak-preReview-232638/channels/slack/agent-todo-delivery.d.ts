import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
type SlackAppLike = {
    client: {
        chat: {
            update: (input: any) => Promise<unknown>;
            postMessage: (input: any) => Promise<unknown>;
        };
    };
};
export declare function renderSlackAgentTodo(input: {
    app: SlackAppLike;
    jid: string;
    channelId: string;
    render: AgentTodoRender;
    providerAccountId?: string;
    todoKey: string;
    pendingTodos: Map<string, {
        channel: string;
        ts: string;
    }>;
}): Promise<boolean>;
export {};
