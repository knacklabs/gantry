import { logger } from '../../infrastructure/logging/logger.js';
export function slackReactionName(emoji) {
    if (emoji === 'seen')
        return 'eyes';
    if (emoji === 'running')
        return 'hourglass_flowing_sand';
    return emoji.replace(/^:+|:+$/g, '');
}
export function isSlackAlreadyReactedError(err) {
    return (typeof err === 'object' &&
        err !== null &&
        'data' in err &&
        typeof err.data?.error === 'string' &&
        err.data.error === 'already_reacted');
}
export async function addSlackReaction(input) {
    if (!input.messageRef.trim())
        return;
    const name = slackReactionName(input.emoji);
    const key = `${input.jid}:${input.messageRef}:${name}`;
    if (input.reactionKeys.has(key))
        return;
    try {
        await input.app.client.reactions.add({
            channel: input.channelId,
            timestamp: input.messageRef,
            name,
        });
        input.reactionKeys.add(key);
    }
    catch (err) {
        if (isSlackAlreadyReactedError(err)) {
            input.reactionKeys.add(key);
            return;
        }
        logger.debug({ jid: input.jid, messageRef: input.messageRef, err }, 'Slack reaction update failed');
    }
}
