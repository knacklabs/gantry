import type {
  AgentTodoRender,
  AgentTodoStatus,
} from '../domain/ports/task-lifecycle.js';

const AGENT_TODO_STATUS_EMOJI: Record<AgentTodoStatus, string> = {
  completed: '✅',
  inProgress: '🔄',
  pending: '⬜',
  blocked: '🚫',
};

export function countCompletedAgentTodos(render: AgentTodoRender): number {
  return render.items.filter((item) => item.status === 'completed').length;
}

export function formatAgentTodoLine(
  item: AgentTodoRender['items'][number],
  escapeText: (value: string) => string = (value) => value,
): string {
  const note = item.note?.trim() ? ` (${escapeText(item.note.trim())})` : '';
  return `${AGENT_TODO_STATUS_EMOJI[item.status]} ${escapeText(item.title)}${note}`;
}

export function agentTodoLines(
  render: AgentTodoRender,
  escapeText?: (value: string) => string,
): string[] {
  return render.items.map((item) => formatAgentTodoLine(item, escapeText));
}
