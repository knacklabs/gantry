import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
export declare function renderTelegramAgentTodo(input: {
    api: {
        editMessageText: (...args: any[]) => Promise<unknown>;
        sendMessage: (...args: any[]) => Promise<{
            message_id: number;
        }>;
    };
    jid: string;
    render: AgentTodoRender;
    todoKey: string;
    pendingTodos: Map<string, {
        chatId: string;
        messageId: number;
    }>;
    sanitizeErrorMessage: (err: unknown) => unknown;
}): Promise<boolean>;
export declare function renderTelegramChannelAgentTodo(input: Omit<Parameters<typeof renderTelegramAgentTodo>[0], 'todoKey'> & {
    buildDraftStreamKey: (jid: string, threadId?: string) => string;
}): Promise<boolean>;
