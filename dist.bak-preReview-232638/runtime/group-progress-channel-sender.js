export function createProgressChannelSender(input) {
    return async (text, options) => {
        if (options?.done !== true &&
            options?.generation !== undefined &&
            input.finalizingGenerations.has(options.generation)) {
            return;
        }
        try {
            if (options) {
                await input.channelRuntime.sendProgressUpdate(input.chatJid, text, options);
            }
            else {
                await input.channelRuntime.sendProgressUpdate(input.chatJid, text);
            }
        }
        catch (err) {
            input.log.warn({
                err,
                chatJid: input.chatJid,
                group: input.groupName,
                progressText: text,
                done: options?.done ?? false,
                replaceOnly: options?.replaceOnly ?? false,
                generation: options?.generation,
                threadId: options?.threadId,
            }, 'Progress lifecycle runtime send failed');
            throw err;
        }
    };
}
