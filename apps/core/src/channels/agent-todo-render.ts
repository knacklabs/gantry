import type {
  AgentTodoCardStatus,
  AgentTodoRender,
  AgentTodoStatus,
} from '../domain/ports/task-lifecycle.js';
import type { MessageActionAffordance } from '../domain/types.js';

const AGENT_TODO_STATUS_EMOJI: Record<AgentTodoStatus, string> = {
  completed: '✅',
  inProgress: '🔄',
  pending: '⬜',
  blocked: '🚫',
};

const AGENT_TODO_CARD_STATUS_EMOJI: Record<AgentTodoCardStatus, string> = {
  running: '⏳',
  waiting: '⏸️',
  done: '✅',
  failed: '❌',
  stopped: '🛑',
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

export function formatAgentProgressLine(
  render: AgentTodoRender,
  escapeText: (value: string) => string = (value) => value,
): string {
  const text =
    render.summary?.trim() ||
    render.headline?.trim() ||
    render.items[0]?.title.trim() ||
    'Working…';
  return escapeText(text);
}

export function hasAgentTodoCardHeader(render: AgentTodoRender): boolean {
  return Boolean(
    render.headline?.trim() || render.status || render.elapsed?.trim(),
  );
}

export function formatAgentTodoHeader(
  render: AgentTodoRender,
  escapeText: (value: string) => string = (value) => value,
): string {
  const title = render.headline?.trim() || render.summary?.trim() || 'Plan';
  const label = render.status
    ? `${AGENT_TODO_CARD_STATUS_EMOJI[render.status]} ${title}`
    : title;
  const elapsed = render.elapsed?.trim();
  return escapeText(elapsed ? `${label} · ${elapsed}` : label);
}

export function agentTodoStopActions(
  render: AgentTodoRender,
): MessageActionAffordance[] | undefined {
  if (
    render.status === 'done' ||
    render.status === 'failed' ||
    render.status === 'stopped'
  ) {
    return undefined;
  }
  const token = render.stop?.actionToken.trim();
  if (!token) return undefined;
  return [
    {
      kind: 'live_turn_stop',
      label: render.stop?.label?.trim() || 'Stop',
      actionToken: token,
    },
  ];
}
