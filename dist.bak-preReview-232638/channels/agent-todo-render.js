const AGENT_TODO_STATUS_EMOJI = {
    completed: '✅',
    inProgress: '🔄',
    pending: '⬜',
    blocked: '🚫',
};
const AGENT_TODO_CARD_STATUS_EMOJI = {
    running: '⏳',
    waiting: '⏸️',
    done: '✅',
    failed: '❌',
    stopped: '🛑',
};
export function countCompletedAgentTodos(render) {
    return render.items.filter((item) => item.status === 'completed').length;
}
export function formatAgentTodoLine(item, escapeText = (value) => value) {
    const note = item.note?.trim() ? ` (${escapeText(item.note.trim())})` : '';
    return `${AGENT_TODO_STATUS_EMOJI[item.status]} ${escapeText(item.title)}${note}`;
}
export function agentTodoLines(render, escapeText) {
    return render.items.map((item) => formatAgentTodoLine(item, escapeText));
}
export function formatAgentProgressLine(render, escapeText = (value) => value) {
    const text = render.summary?.trim() ||
        render.headline?.trim() ||
        render.items[0]?.title.trim() ||
        'Working…';
    return escapeText(text);
}
export function hasAgentTodoCardHeader(render) {
    return Boolean(render.headline?.trim() || render.status);
}
export function formatAgentTodoHeader(render, escapeText = (value) => value) {
    const title = render.headline?.trim() || render.summary?.trim() || 'Plan';
    const label = render.status
        ? `${AGENT_TODO_CARD_STATUS_EMOJI[render.status]} ${title}`
        : title;
    return escapeText(label);
}
export function agentTodoStopActions(render) {
    if (render.status === 'done' ||
        render.status === 'failed' ||
        render.status === 'stopped') {
        return undefined;
    }
    const token = render.stop?.actionToken.trim();
    if (!token)
        return undefined;
    return [
        {
            kind: 'live_turn_stop',
            label: render.stop?.label?.trim() || 'Stop',
            actionToken: token,
        },
    ];
}
