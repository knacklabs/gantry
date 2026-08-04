import { parseTriggerRequesterSessionId } from './execution-context.js';
export async function resolveAppSessionForJob(job, control) {
    if (!job.session_id)
        return undefined;
    return (await control.getAppSessionById(job.session_id)) || undefined;
}
export async function resolveAppSessionForTrigger(requestedBy, control) {
    const sessionId = parseTriggerRequesterSessionId(requestedBy);
    return sessionId
        ? (await control.getAppSessionById(sessionId)) || undefined
        : undefined;
}
