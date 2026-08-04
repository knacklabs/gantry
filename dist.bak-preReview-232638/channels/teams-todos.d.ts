import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import type { TeamsSdkClient } from './teams-types.js';
export type TeamsTodoMessages = Map<string, {
    conversationId: string;
    messageId?: string;
}>;
export declare function renderTeamsAgentTodo(input: {
    sdkClient: TeamsSdkClient;
    pendingTodos: TeamsTodoMessages;
    jid: string;
    render: AgentTodoRender;
}): Promise<boolean>;
