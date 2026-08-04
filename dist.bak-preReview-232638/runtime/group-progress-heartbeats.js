import { buildReplaceOnlyProgressOptions } from './progress-updates.js';
const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;
function logProgressLifecycle(log, metadata, message) {
    if (log.info) {
        log.info(metadata, message);
    }
    else {
        log.debug(metadata, message);
    }
}
export function startInitialGroupProgress(input) {
    if (!input.supportsProgress) {
        logProgressLifecycle(input.log, { group: input.groupName, supportsProgress: false }, 'Progress lifecycle initial skipped');
        return { cancel: async () => undefined };
    }
    logProgressLifecycle(input.log, { group: input.groupName }, 'Progress lifecycle initial Stop affordance send');
    const send = input
        .sendProgressToChannel('', {
        ...input.buildProgressOptions(),
        actionOnly: true,
    })
        .then(() => input.onSent?.())
        .catch((err) => input.log.debug({ err, group: input.groupName }, 'Progress lifecycle initial Stop affordance failed'));
    return {
        cancel: async () => {
            await send;
        },
    };
}
export function createResponseProgressSenders(input) {
    return {
        sendWaitingProgress: () => input.supportsProgress
            ? input
                .sendProgressToChannel('Waiting for your input.', buildReplaceOnlyProgressOptions(input.activeThreadId, input.progressGeneration?.()))
                .catch(() => undefined)
            : Promise.resolve(),
        sendResponseReceipt: async () => {
            if (input.supportsProgress) {
                return input
                    .sendProgressToChannel('Response received. Continuing...', buildReplaceOnlyProgressOptions(input.activeThreadId, input.progressGeneration?.()))
                    .catch(() => undefined);
            }
            return Promise.resolve();
        },
    };
}
export function startGroupProgressHeartbeats(input) {
    let paused = false;
    const typingHeartbeatTimer = setInterval(() => {
        if (paused || !input.isTypingActive())
            return;
        const typing = input.providerAccountId
            ? input.channelRuntime.setTyping(input.chatJid, true, {
                providerAccountId: input.providerAccountId,
            })
            : input.channelRuntime.setTyping(input.chatJid, true);
        void typing.catch((err) => input.log.debug({ err, group: input.groupName }, 'Failed to refresh typing heartbeat'));
    }, TYPING_HEARTBEAT_INTERVAL_MS);
    return {
        typingHeartbeatTimer,
        pause: () => {
            paused = true;
        },
        resume: () => {
            paused = false;
        },
    };
}
