export function createSessionCommandAgentRunners(input) {
    const commandOptions = (options = {}) => ({
        ...options,
        memoryContext: {
            source: 'command',
            userId: input.memoryUserId,
            threadId: input.activeThreadId,
        },
        turnMessages: input.missedMessages,
        existingRunId: input.existingRunId,
        existingRunLeaseToken: input.existingRunLeaseToken,
        existingRunLeaseWorkerInstanceId: input.existingRunLeaseWorkerInstanceId,
        existingRunLeaseFencingVersion: input.existingRunLeaseFencingVersion,
    });
    return {
        runAgent: (prompt, onOutput, options) => input.runAgent(input.group, prompt, input.chatJid, input.queueJid, onOutput, commandOptions(options)),
        runSessionCompaction: (onOutput, options) => input.runAgent(input.group, '', input.chatJid, input.queueJid, onOutput, commandOptions({ ...options, maintenanceCompaction: true })),
    };
}
