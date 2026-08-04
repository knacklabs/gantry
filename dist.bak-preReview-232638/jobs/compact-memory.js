import { MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS, runWithMemoryOperationTimeout, } from '../shared/memory-dreaming-timeout.js';
export async function collectCompactBoundaryMemory(input) {
    const agentSessionId = input.agentSessionId;
    const collectMemory = input.collectMemory;
    if (!input.compactBoundary || !agentSessionId || !collectMemory) {
        return;
    }
    try {
        const result = await runWithMemoryOperationTimeout((signal) => collectMemory({
            agentSessionId,
            trigger: 'precompact',
            ...(input.defaultScope ? { defaultScope: input.defaultScope } : {}),
            signal,
            timeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
            statementTimeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
        }), {
            timeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
            label: 'memory collection',
        });
        input.logger.info({
            ...input.context,
            agentSessionId,
            saved: result.saved,
        }, 'Collected durable memory at SDK compact boundary');
    }
    catch (err) {
        input.logger.warn({ ...input.context, err }, 'Failed to collect durable memory at SDK compact boundary');
    }
}
export async function collectJobCompletionMemory(input) {
    const agentSessionId = input.agentSessionId;
    const collectMemory = input.collectMemory;
    const additionalTurns = [
        input.prompt ? { role: 'user', text: input.prompt } : null,
        input.result ? { role: 'assistant', text: input.result } : null,
    ].filter((turn) => Boolean(turn?.text.trim()));
    if (!agentSessionId || !collectMemory || additionalTurns.length === 0) {
        return;
    }
    try {
        const result = await runWithMemoryOperationTimeout((signal) => collectMemory({
            agentSessionId,
            trigger: 'session-end',
            ...(input.defaultScope ? { defaultScope: input.defaultScope } : {}),
            additionalTurns,
            signal,
            timeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
            statementTimeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
        }), {
            timeoutMs: MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS,
            label: 'memory collection',
        });
        input.logger.info({
            ...input.context,
            agentSessionId: input.agentSessionId,
            saved: result.saved,
        }, 'Collected durable memory after successful job run');
    }
    catch (err) {
        input.logger.warn({ ...input.context, err }, 'Failed to collect durable memory after successful job run');
    }
}
