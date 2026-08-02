import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { CALLABLE_AGENT_TOOL_PREFIX } from '../../shared/callable-agent-manifest.js';
import { canonicalGantryToolRuleName } from '../../shared/gantry-tool-facades.js';
const TOOL_ACTIVITY_INTERVAL_MS = 15_000;
export function createInlineToolActivity(input) {
    const timers = new Map();
    const callableAgentToolNames = new Set(input.coreTools.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith(CALLABLE_AGENT_TOOL_PREFIX)));
    let sequence = 0;
    const emit = async (toolName, phase) => {
        if (!input.input.isScheduledJob)
            return;
        const canonicalToolName = canonicalGantryToolRuleName(toolName, {
            callableAgentToolNames,
        });
        await input
            .emitOutput({
            status: 'success',
            result: null,
            runtimeEventOnly: true,
            runtimeEvents: [
                {
                    appId: input.input.appId,
                    agentId: input.input.agentId,
                    runId: input.input.runId,
                    jobId: input.input.jobId,
                    conversationId: input.input.chatJid,
                    threadId: input.input.threadId,
                    eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
                    actor: 'inline-agent',
                    responseMode: 'none',
                    payload: {
                        phase,
                        tool: canonicalToolName,
                        ...(phase === 'success' ? { ok: true } : {}),
                        ...(phase === 'failure' ? { ok: false } : {}),
                    },
                },
            ],
        })
            .catch(() => undefined);
    };
    const start = async (id, toolName) => {
        if (!input.input.isScheduledJob)
            return;
        await emit(toolName, 'started');
        const timer = setInterval(() => void emit(toolName, 'running'), TOOL_ACTIVITY_INTERVAL_MS);
        timer.unref?.();
        timers.set(id, timer);
    };
    const finish = async (id, toolName, outcome) => {
        const timer = timers.get(id);
        if (timer)
            clearInterval(timer);
        timers.delete(id);
        await emit(toolName, outcome);
    };
    return {
        async run(toolName, operation) {
            const id = `inline-tool-${sequence++}`;
            await start(id, toolName);
            try {
                const result = await operation();
                await finish(id, toolName, 'success');
                return result;
            }
            catch (error) {
                await finish(id, toolName, 'failure');
                throw error;
            }
        },
        start,
        finish,
        close() {
            for (const timer of timers.values())
                clearInterval(timer);
            timers.clear();
        },
    };
}
