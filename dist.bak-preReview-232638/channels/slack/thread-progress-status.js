import { logger } from '../../infrastructure/logging/logger.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';
function slackApiCallOk(result) {
    return (typeof result === 'object' &&
        result !== null &&
        result.ok === true);
}
export function isSlackTerminalSuccessText(text) {
    return text === 'Done.';
}
export async function sendSlackThreadProgressStatus(input) {
    try {
        const result = await input.app.client.apiCall('assistant.threads.setStatus', {
            channel_id: input.channelId,
            thread_ts: input.threadTs,
            status: input.statusText,
        });
        if (!slackApiCallOk(result)) {
            logger.warn({
                channelId: input.channelId,
                threadTs: input.threadTs,
                key: input.key,
                statusText: input.statusText,
                slackError: typeof result === 'object' && result !== null
                    ? result.error
                    : undefined,
            }, 'Progress lifecycle slack thread status failed');
            return false;
        }
        logger.info({
            channelId: input.channelId,
            threadTs: input.threadTs,
            key: input.key,
            statusText: input.statusText,
            done: input.options.done ?? false,
            replaceOnly: input.options.replaceOnly ?? false,
            generation: input.options.generation,
        }, 'Progress lifecycle slack thread status sent');
        return true;
    }
    catch (err) {
        logger.warn({
            channelId: input.channelId,
            threadTs: input.threadTs,
            key: input.key,
            statusText: input.statusText,
            err,
        }, 'Progress lifecycle slack thread status failed');
        return false;
    }
}
export async function handleSlackThreadProgressStatus(input) {
    const threadTs = slackThreadTsFromThreadId(input.options.threadId);
    if (!threadTs)
        return false;
    const actionOnly = Boolean(input.options.actionOnly && input.options.actionAffordances?.length);
    const trimmedText = input.text.trim();
    const clearingTerminalStatus = Boolean(input.options.done && isSlackTerminalSuccessText(trimmedText));
    const statusText = clearingTerminalStatus
        ? ''
        : actionOnly
            ? 'Looking into it...'
            : trimmedText;
    if (!statusText && !clearingTerminalStatus)
        return false;
    const sent = await sendSlackThreadProgressStatus({
        ...input,
        threadTs,
        statusText,
    });
    if (!sent)
        return false;
    if (input.options.done)
        input.onDone();
    return true;
}
