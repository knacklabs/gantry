import { agentIdForJobWorkspaceKey } from './job-tool-policy.js';
import { canAccessSchedulerJob } from './job-management-access.js';
export function isVisibleJob(job, input) {
    if (input.appId)
        return false;
    if (input.access && !canAccessSchedulerJob(job, input.access))
        return false;
    if (input.agentId &&
        agentIdForJobWorkspaceKey(job.workspace_key) !== input.agentId)
        return false;
    if (input.kind && jobKindFor(job) !== input.kind)
        return false;
    if (input.conversationJid &&
        !jobTargetsConversation(job, input.conversationJid)) {
        return false;
    }
    return true;
}
export function jobKindFor(job) {
    if (job.schedule_type === 'manual')
        return 'manual';
    if (job.schedule_type === 'once')
        return 'once';
    return 'recurring';
}
function jobTargetsConversation(job, conversationJid) {
    const notificationRoutes = Array.isArray(job.notification_routes)
        ? job.notification_routes
        : [];
    if (notificationRoutes.length > 0) {
        return notificationRoutes.some((route) => route.conversationJid === conversationJid);
    }
    return job.execution_context?.conversationJid === conversationJid;
}
