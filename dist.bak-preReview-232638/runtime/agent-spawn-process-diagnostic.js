import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { logger } from '../infrastructure/logging/logger.js';
export function publishRunnerProcessStartupDiagnostic(input) {
    const publishRuntimeEvent = input.spec.options?.publishRuntimeEvent;
    const agentInput = input.spec.input;
    if (!publishRuntimeEvent || !agentInput.appId)
        return;
    const event = {
        appId: agentInput.appId,
        ...(agentInput.agentId
            ? { agentId: agentInput.agentId }
            : {}),
        ...(agentInput.runId
            ? { runId: agentInput.runId }
            : {}),
        ...(agentInput.jobId
            ? { jobId: agentInput.jobId }
            : {}),
        conversationId: agentInput.chatJid,
        ...(agentInput.threadId
            ? {
                threadId: agentInput.threadId,
            }
            : {}),
        eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
        actor: 'runtime',
        responseMode: 'none',
        payload: {
            provider: 'host',
            diagnostic: 'runner_process_timing',
            sandbox: {
                provider: input.spec.options?.runnerSandboxProvider.id,
                enforcing: input.spec.options?.runnerSandboxProvider.enforcing === true,
            },
            exit: {
                code: input.code,
                signal: input.signal ?? null,
                timedOut: input.timedOut,
                ...(input.timedOut ? { timeoutReason: input.timeoutReason } : {}),
                hadStreamingOutput: input.hadStreamingOutput,
            },
            startupTiming: input.startupTiming,
        },
    };
    try {
        void Promise.resolve(publishRuntimeEvent(event)).catch((err) => {
            logger.warn({
                err,
                appId: agentInput.appId,
                runId: agentInput.runId,
                jobId: agentInput.jobId,
            }, 'Runner process startup diagnostic persistence failed');
        });
    }
    catch (err) {
        logger.warn({
            err,
            appId: agentInput.appId,
            runId: agentInput.runId,
            jobId: agentInput.jobId,
        }, 'Runner process startup diagnostic persistence failed');
    }
}
