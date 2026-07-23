export type AgentTodoStatus =
  'pending' | 'inProgress' | 'completed' | 'blocked';

export interface AgentTodoItem {
  id: string;
  title: string;
  status: AgentTodoStatus;
  note?: string;
}

export type AgentTodoCardStatus =
  'running' | 'waiting' | 'done' | 'failed' | 'stopped';

/** Channel-agnostic payload for rendering an agent's live todo/plan. */
export interface AgentTodoRender {
  summary: string | null;
  items: AgentTodoItem[];
  headline?: string | null;
  status?: AgentTodoCardStatus;
  stop?: {
    label?: string;
    actionToken: string;
  };
  threadId?: string | null;
  updatedAt?: string;
  flush?: boolean;
  cardKind?: 'todo' | 'progress';
}

/**
 * Optional channel capability: render (and live-update in place) the agent's
 * todo/plan for a conversation. Channels that do not implement it are skipped.
 */
export interface AgentTodoSink {
  renderAgentTodo(
    jid: string,
    render: AgentTodoRender,
  ): Promise<void | boolean>;
}
