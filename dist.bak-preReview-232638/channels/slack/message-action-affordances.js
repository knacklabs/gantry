const SLACK_ACTION_VALUE_MAX_BYTES = 2000;
const SCHEDULER_ACTION_KINDS = new Set([
    'scheduler_run_now',
    'scheduler_pause_job',
]);
function truncateSlackButtonLabel(label) {
    const trimmed = label.trim();
    if (trimmed.length <= 75)
        return trimmed;
    return `${trimmed.slice(0, 72)}...`;
}
function slackActionValue(action, providerAccountId) {
    if (action.kind === 'live_turn_stop')
        return undefined;
    const value = SCHEDULER_ACTION_KINDS.has(action.kind)
        ? JSON.stringify({
            kind: action.kind,
            jobId: action.jobId,
            runId: action.runId ?? null,
            ...(providerAccountId ? { providerAccountId } : {}),
        })
        : undefined;
    if (!value)
        return undefined;
    return Buffer.byteLength(value, 'utf8') <= SLACK_ACTION_VALUE_MAX_BYTES
        ? value
        : undefined;
}
export function slackMessageActionBlocks(text, actions, options = {}) {
    const elements = (actions ?? [])
        .map((action) => {
        const value = slackActionValue(action, options.providerAccountId);
        if (!value)
            return null;
        return {
            type: 'button',
            action_id: 'gantry_message_action',
            text: {
                type: 'plain_text',
                text: truncateSlackButtonLabel(action.label),
            },
            ...(action.kind === 'scheduler_pause_job'
                ? { style: 'danger' }
                : {}),
            value,
        };
    })
        .filter((action) => action !== null);
    if (elements.length === 0)
        return undefined;
    const actionBlock = {
        type: 'actions',
        elements,
    };
    return options.actionOnly
        ? [actionBlock]
        : [
            {
                type: 'section',
                text: { type: 'mrkdwn', text },
            },
            actionBlock,
        ];
}
