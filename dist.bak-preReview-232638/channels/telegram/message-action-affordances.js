const TELEGRAM_ACTION_CALLBACK_BY_KIND = {
    scheduler_run_now: 'retry',
    scheduler_pause_job: 'pause',
    live_turn_stop: '',
};
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
function telegramSchedulerActionCallback(action) {
    if (action.kind !== 'scheduler_run_now') {
        return `dl:${TELEGRAM_ACTION_CALLBACK_BY_KIND[action.kind]}`;
    }
    const callbackData = `r:${encodeURIComponent(action.jobId)}`;
    return Buffer.byteLength(callbackData, 'utf8') <=
        TELEGRAM_CALLBACK_DATA_MAX_BYTES
        ? callbackData
        : undefined;
}
export function telegramActionReplyMarkup(actions) {
    const buttons = (actions ?? [])
        .map((action) => {
        if (action.kind === 'live_turn_stop')
            return null;
        const code = TELEGRAM_ACTION_CALLBACK_BY_KIND[action.kind];
        if (!code || !action.label.trim())
            return null;
        const callbackData = telegramSchedulerActionCallback(action);
        if (!callbackData)
            return null;
        return {
            text: action.label.trim(),
            callback_data: callbackData,
        };
    })
        .filter((button) => button !== null);
    if (buttons.length === 0)
        return undefined;
    const inline_keyboard = [];
    for (let index = 0; index < buttons.length; index += 2) {
        inline_keyboard.push(buttons.slice(index, index + 2));
    }
    return { inline_keyboard };
}
