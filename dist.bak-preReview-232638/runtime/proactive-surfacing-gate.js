import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { patternSubjectForScope } from '../shared/pattern-candidate-subject.js';
import { buildProactiveSurfacingMetricPayloads, } from './proactive-surfacing-metrics.js';
export async function proactiveSurfacingAllowed(deps, scope) {
    if (deps.getAgentLockStatus?.(scope.folder) !== 'full') {
        return { allowed: false };
    }
    const subject = patternSubjectForScope(scope);
    if (!subject)
        return { allowed: false };
    const repo = deps.getProactiveSurfacingRepository?.();
    if (!repo) {
        return {
            allowed: false,
            subjectId: subject.subjectId,
            failClosedOutcome: 'opt_in_unavailable',
        };
    }
    try {
        const optIn = await repo.getBySubject({
            appId: subject.appId,
            agentId: subject.agentId,
            subjectType: subject.subjectType,
            subjectId: subject.subjectId,
        });
        if (optIn?.proactiveSurfacingEnabled === false) {
            return {
                allowed: false,
                subjectId: subject.subjectId,
                failClosedOutcome: 'opted_out',
            };
        }
        return {
            allowed: optIn?.proactiveSurfacingEnabled === true,
            subjectId: subject.subjectId,
        };
    }
    catch {
        return {
            allowed: false,
            subjectId: subject.subjectId,
            failClosedOutcome: 'opt_in_unavailable',
        };
    }
}
export function publishProactiveSurfacingOutcomeEvent(input) {
    if (!input.publish || !input.appId || !input.subjectId)
        return;
    const payloads = buildProactiveSurfacingMetricPayloads({
        subjectId: input.subjectId,
        candidates: input.candidates,
        outcome: input.outcome,
    });
    for (const payload of payloads) {
        void Promise.resolve(input.publish({
            appId: input.appId,
            ...(input.agentId ? { agentId: input.agentId } : {}),
            ...(input.runId ? { runId: input.runId } : {}),
            conversationId: input.conversationId,
            ...(input.threadId ? { threadId: input.threadId } : {}),
            eventType: RUNTIME_EVENT_TYPES.PROACTIVE_SURFACING_OUTCOME,
            actor: 'runtime',
            responseMode: 'none',
            payload,
        })).catch(() => { });
    }
}
