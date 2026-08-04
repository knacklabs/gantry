import { randomUUID } from 'crypto';
export function createGroupTurnOptionBuilders(input) {
    const resolveThreadId = (threadId) => threadId ?? input.activeThreadId;
    const liveStopActionToken = randomUUID();
    return {
        buildMessageOptions: (threadId) => {
            const resolved = resolveThreadId(threadId);
            if (!resolved && !input.providerAccountId)
                return undefined;
            return {
                ...(resolved ? { threadId: resolved } : {}),
                ...(input.providerAccountId
                    ? { providerAccountId: input.providerAccountId }
                    : {}),
            };
        },
        buildStreamingOptions: (args) => ({
            generation: input.streamGeneration(),
            ...(resolveThreadId(args.threadId)
                ? { threadId: resolveThreadId(args.threadId) }
                : {}),
            ...(input.providerAccountId
                ? { providerAccountId: input.providerAccountId }
                : {}),
            ...(args.done !== undefined ? { done: args.done } : {}),
        }),
        liveStopActionToken,
        buildProgressOptions: (args = {}) => ({
            ...(resolveThreadId(args.threadId)
                ? { threadId: resolveThreadId(args.threadId) }
                : {}),
            ...(input.providerAccountId
                ? { providerAccountId: input.providerAccountId }
                : {}),
            generation: input.progressGeneration(),
            ...(args.done !== undefined ? { done: args.done } : {}),
            ...(args.replaceOnly !== undefined
                ? { replaceOnly: args.replaceOnly }
                : {}),
            ...(args.done
                ? {}
                : {
                    actionAffordances: [
                        {
                            kind: 'live_turn_stop',
                            label: 'Stop',
                            actionToken: liveStopActionToken,
                        },
                    ],
                }),
        }),
    };
}
