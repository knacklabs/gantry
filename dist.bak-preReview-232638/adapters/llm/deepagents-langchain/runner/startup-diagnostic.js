import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
export function createDeepAgentStartupTiming(input) {
    const startedAt = input.nowMs();
    const phases = {};
    let toolsReadyMs;
    let firstLangGraphEventMs;
    let firstLangGraphEventName;
    let firstVisibleOutputMs;
    let firstToolStartMs;
    let toolStartCount = 0;
    const elapsedSince = (since) => Math.max(0, Math.round(input.nowMs() - since));
    const elapsedFromStart = () => elapsedSince(startedAt);
    return {
        measure(phase, work) {
            const phaseStartedAt = input.nowMs();
            try {
                return work();
            }
            finally {
                phases[phase] = elapsedSince(phaseStartedAt);
            }
        },
        async measureAsync(phase, work) {
            const phaseStartedAt = input.nowMs();
            try {
                return await work();
            }
            finally {
                phases[phase] = elapsedSince(phaseStartedAt);
            }
        },
        markFirstLangGraphEvent(eventName) {
            if (firstLangGraphEventMs !== undefined)
                return;
            firstLangGraphEventMs = elapsedFromStart();
            firstLangGraphEventName = eventName;
        },
        markFirstVisibleOutput() {
            if (firstVisibleOutputMs !== undefined)
                return;
            firstVisibleOutputMs = elapsedFromStart();
        },
        markToolsReady() {
            if (toolsReadyMs !== undefined)
                return;
            toolsReadyMs = elapsedFromStart();
        },
        markToolStart() {
            toolStartCount += 1;
            if (firstToolStartMs !== undefined)
                return;
            firstToolStartMs = elapsedFromStart();
        },
        snapshot() {
            return {
                totalMs: elapsedFromStart(),
                phases: { ...phases },
                ...(toolsReadyMs !== undefined ? { toolsReadyMs } : {}),
                ...(firstLangGraphEventMs !== undefined
                    ? { firstLangGraphEventMs }
                    : {}),
                ...(firstLangGraphEventName ? { firstLangGraphEventName } : {}),
                ...(firstVisibleOutputMs !== undefined ? { firstVisibleOutputMs } : {}),
                ...(firstToolStartMs !== undefined ? { firstToolStartMs } : {}),
                toolStartCount,
            };
        },
    };
}
export function buildDeepAgentStartupDiagnosticEvent(input) {
    return {
        ...(input.agentInput.appId ? { appId: input.agentInput.appId } : {}),
        ...(input.agentInput.agentId ? { agentId: input.agentInput.agentId } : {}),
        ...(input.agentInput.runId ? { runId: input.agentInput.runId } : {}),
        ...(input.agentInput.jobId ? { jobId: input.agentInput.jobId } : {}),
        conversationId: input.agentInput.chatJid,
        ...(input.agentInput.threadId
            ? { threadId: input.agentInput.threadId }
            : {}),
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
        actor: 'runtime',
        responseMode: 'none',
        payload: {
            provider: 'deepagents',
            diagnostic: 'runner_startup',
            modelProvider: input.modelProvider,
            modelId: input.modelId,
            endpointFamily: input.endpointFamily,
            selectedAllowedToolCount: input.selectedAllowedToolCount,
            connectedToolCount: input.connectedToolCount,
            systemPromptChars: input.systemPromptChars,
            memoryContextChars: input.memoryContextChars,
            turnMessageCount: input.turnMessageCount,
            cacheMode: input.cacheMode,
            checkpointerConfigured: input.checkpointerConfigured,
            deepAgentSkillSourceCount: input.deepAgentSkillSourceCount ?? 0,
            deepAgentSkillFileCount: input.deepAgentSkillFileCount ?? 0,
            deepAgentSkillContentBytes: input.deepAgentSkillContentBytes ?? 0,
            deepAgentSkillReadToolsEnabled: input.deepAgentSkillReadToolsEnabled === true,
            ...(input.checkpointTiming
                ? {
                    checkpointLoadCount: input.checkpointTiming.loadCount,
                    checkpointLoadMs: input.checkpointTiming.loadMs,
                    ...(input.checkpointTiming.maxLoadMs !== undefined
                        ? { checkpointMaxLoadMs: input.checkpointTiming.maxLoadMs }
                        : {}),
                    checkpointWriteCount: input.checkpointTiming.writeCount,
                    checkpointWriteMs: input.checkpointTiming.writeMs,
                    ...(input.checkpointTiming.maxWriteMs !== undefined
                        ? { checkpointMaxWriteMs: input.checkpointTiming.maxWriteMs }
                        : {}),
                }
                : {}),
            scheduledJob: input.scheduledJob,
            totalMs: input.timing.totalMs,
            phases: input.timing.phases,
            ...(input.timing.toolsReadyMs !== undefined
                ? { toolsReadyMs: input.timing.toolsReadyMs }
                : {}),
            ...(input.timing.firstLangGraphEventMs !== undefined
                ? { firstLangGraphEventMs: input.timing.firstLangGraphEventMs }
                : {}),
            ...(input.timing.firstLangGraphEventName
                ? { firstLangGraphEventName: input.timing.firstLangGraphEventName }
                : {}),
            ...(input.timing.firstVisibleOutputMs !== undefined
                ? { firstVisibleOutputMs: input.timing.firstVisibleOutputMs }
                : {}),
            ...(input.timing.firstToolStartMs !== undefined
                ? { firstToolStartMs: input.timing.firstToolStartMs }
                : {}),
            toolStartCount: input.timing.toolStartCount,
        },
    };
}
