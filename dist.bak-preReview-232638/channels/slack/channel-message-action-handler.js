const SCHEDULER_MESSAGE_ACTION_KINDS = new Set([
    'scheduler_run_now',
    'scheduler_pause_job',
]);
export function registerSlackMessageActionHandler(app, opts) {
    app.action('gantry_message_action', async (args) => {
        await args.ack();
        const action = args.action;
        const body = args.body;
        let payload;
        try {
            payload = action.value ? JSON.parse(action.value) : undefined;
        }
        catch {
            return;
        }
        if (!payload ||
            typeof payload.kind !== 'string' ||
            !SCHEDULER_MESSAGE_ACTION_KINDS.has(payload.kind) ||
            typeof payload.jobId !== 'string' ||
            payload.jobId.trim().length === 0 ||
            !body.channel?.id ||
            !body.user?.id) {
            return;
        }
        if (payload.kind === 'scheduler_run_now') {
            await opts?.onMessageAction?.({
                kind: 'scheduler_run_now',
                conversationJid: `sl:${body.channel.id}`,
                ...providerAccountFromPayload(payload, opts?.providerAccountId),
                threadId: body.message?.thread_ts,
                userId: body.user.id,
                jobId: payload.jobId,
                runId: typeof payload.runId === 'string' ? payload.runId : null,
            });
            return;
        }
        try {
            await app.client.chat.postEphemeral({
                channel: body.channel.id,
                user: body.user.id,
                text: 'Scheduler action buttons are visible hints only in this channel. Open the scheduler surface or use scheduler tools to run this action.',
            });
        }
        catch {
            // ignore callback feedback failures
        }
    });
}
function providerAccountFromPayload(payload, fallback) {
    if (typeof payload?.providerAccountId === 'string') {
        return { providerAccountId: payload.providerAccountId };
    }
    return fallback ? { providerAccountId: fallback } : {};
}
