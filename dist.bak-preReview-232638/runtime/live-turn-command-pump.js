export function createLiveTurnCommandPump(input) {
    const batchLimit = Math.max(1, input.batchLimit ?? 32);
    // Serialized tail: every drain() request chains a drainOnce that is
    // guaranteed to start after the request, so a command appended right
    // before drain() is always observed. The tail never rejects.
    let tail = Promise.resolve(0);
    async function drainOnce() {
        let appliedCount = 0;
        for (;;) {
            const pending = await input.liveTurns.listPendingLiveTurnCommands({
                liveTurnId: input.turnId,
                limit: batchLimit,
            });
            if (pending.length === 0)
                return appliedCount;
            for (const command of pending) {
                if (input.canApplyCommand && !input.canApplyCommand(command)) {
                    return appliedCount;
                }
                const handler = input.handlers[command.commandType];
                if (!handler) {
                    const marked = await input.liveTurns.markLiveTurnCommandRejected({
                        id: command.id,
                        reason: `unsupported command type: ${command.commandType}`,
                        fence: input.fence,
                    });
                    if (!marked)
                        return appliedCount;
                    continue;
                }
                const fenceActive = await input.liveTurns.isLiveTurnCommandFenceActive({
                    id: command.id,
                    fence: input.fence,
                });
                if (!fenceActive)
                    return appliedCount;
                let result;
                try {
                    result = await handler(command);
                }
                catch (err) {
                    input.onError?.(err, command);
                    return appliedCount;
                }
                if (result !== 'applied') {
                    input.onError?.(new Error(`live-turn command handler returned ${result}`), command);
                    return appliedCount;
                }
                const marked = await input.liveTurns.markLiveTurnCommandApplied({
                    id: command.id,
                    appliedByWorkerId: input.fence.workerInstanceId,
                    fence: input.fence,
                });
                if (!marked)
                    return appliedCount;
                appliedCount += 1;
            }
            if (pending.length < batchLimit)
                return appliedCount;
        }
    }
    function drain() {
        const next = tail.then(() => drainOnce());
        // Keep the tail resilient: a failed drainOnce must not poison later
        // drains. Callers still observe the failure on their own `next`.
        tail = next.then(() => 0, () => 0);
        return next;
    }
    return { drain };
}
