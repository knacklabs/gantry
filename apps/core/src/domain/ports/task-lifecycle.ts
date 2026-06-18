export type AgentTodoStatus =
  | 'pending'
  | 'inProgress'
  | 'completed'
  | 'blocked';

export interface AgentTodoItem {
  id: string;
  title: string;
  status: AgentTodoStatus;
  note?: string;
}

/** Channel-agnostic payload for rendering an agent's live todo/plan. */
export interface AgentTodoRender {
  summary: string | null;
  items: AgentTodoItem[];
  threadId?: string | null;
  updatedAt?: string;
}

/**
 * Optional channel capability: render (and live-update in place) the agent's
 * todo/plan for a conversation. Channels that do not implement it are skipped.
 */
export interface AgentTodoSink {
  renderAgentTodo(jid: string, render: AgentTodoRender): Promise<void>;
}
