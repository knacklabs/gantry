import { createHash } from 'node:crypto';
export const JOB_NOTIFICATION_START_PROFILE_ID = 'job.notification.start.v1';
export const JOB_NOTIFICATION_SUMMARY_PROFILE_ID = 'job.notification.summary.v1';
export function resolveJobNotificationRoutes(source) {
    const explicitRoutes = dedupeRoutes(normalizeRoutes(source.notification_routes ?? source.notificationRoutes ?? []));
    if (explicitRoutes.length > 0)
        return explicitRoutes;
    const fallback = executionContextToRoute(source.execution_context ?? source.executionContext);
    return fallback ? [fallback] : [];
}
export function profileIdForJobNotificationPhase(phase) {
    return phase === 'start'
        ? JOB_NOTIFICATION_START_PROFILE_ID
        : JOB_NOTIFICATION_SUMMARY_PROFILE_ID;
}
export function buildJobNotificationIdempotencyKey(input) {
    const digest = createHash('sha256')
        .update(JSON.stringify({
        version: 'v1',
        jobId: input.jobId,
        runId: normalizeOptional(input.runId) ?? null,
        phase: input.phase,
        conversationJid: input.route.conversationJid,
        threadId: input.route.threadId,
        providerAccountId: input.route.providerAccountId ?? null,
    }), 'utf8')
        .digest('hex')
        .slice(0, 40);
    return `job.notification:${input.phase}:${digest}`;
}
export function buildCanonicalJobLifecycleTarget(input) {
    const conversationJid = normalizeOptional(input.conversationJid);
    const workspaceKey = normalizeOptional(input.workspaceKey);
    if (!conversationJid || !workspaceKey) {
        throw new Error('Canonical job lifecycle target requires conversationJid and workspaceKey.');
    }
    const threadId = normalizeOptional(input.threadId) ?? null;
    const providerAccountId = normalizeOptional(input.providerAccountId);
    const executionContext = {
        conversationJid,
        threadId,
        workspaceKey,
        sessionId: normalizeOptional(input.sessionId) ?? null,
    };
    return {
        executionContext,
        notificationRoutes: [
            {
                conversationJid,
                threadId,
                ...(providerAccountId ? { providerAccountId } : {}),
                label: normalizeOptional(input.label) ?? 'Primary',
            },
        ],
    };
}
function normalizeRoutes(routes) {
    const normalized = [];
    for (const route of routes) {
        const conversationJid = normalizeOptional(route?.conversationJid);
        if (!conversationJid)
            continue;
        normalized.push({
            conversationJid,
            threadId: normalizeOptional(route?.threadId) ?? null,
            providerAccountId: normalizeOptional(route?.providerAccountId),
            label: normalizeOptional(route?.label) ?? conversationJid,
        });
    }
    return normalized;
}
function dedupeRoutes(routes) {
    const seen = new Set();
    const unique = [];
    for (const route of routes) {
        const key = `${route.conversationJid}\u0000${route.threadId ?? ''}\u0000${route.providerAccountId ?? ''}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(route);
    }
    return unique;
}
function executionContextToRoute(context) {
    if (!context)
        return null;
    const conversationJid = normalizeOptional(context.conversationJid);
    if (!conversationJid)
        return null;
    return {
        conversationJid,
        threadId: normalizeOptional(context.threadId) ?? null,
        label: 'Primary',
    };
}
function normalizeOptional(value) {
    if (typeof value !== 'string')
        return undefined;
    const normalized = value.trim();
    return normalized || undefined;
}
