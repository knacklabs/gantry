import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import type { MessageActionAffordance } from '../domain/types.js';
export declare function countCompletedAgentTodos(render: AgentTodoRender): number;
export declare function formatAgentTodoLine(item: AgentTodoRender['items'][number], escapeText?: (value: string) => string): string;
export declare function agentTodoLines(render: AgentTodoRender, escapeText?: (value: string) => string): string[];
export declare function formatAgentProgressLine(render: AgentTodoRender, escapeText?: (value: string) => string): string;
export declare function hasAgentTodoCardHeader(render: AgentTodoRender): boolean;
export declare function formatAgentTodoHeader(render: AgentTodoRender, escapeText?: (value: string) => string): string;
export declare function agentTodoStopActions(render: AgentTodoRender): MessageActionAffordance[] | undefined;
