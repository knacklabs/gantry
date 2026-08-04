import { createHash } from 'node:crypto';
import { nowIso as runtimeNowIso } from '../../shared/time/datetime.js';
import { resolveAppScopeAppId as applicationResolveAppScopeAppId } from '../../application/app-scope/resolve-app-scope.js';
import { modelUseKindForJobSchedule, resolveJobModel, } from '../../application/jobs/job-model-resolution.js';
export function nowIso() {
    return runtimeNowIso();
}
function sanitizeSegment(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
}
export function makeAppGroup(input) {
    const app = sanitizeSegment(input.appId) || 'app';
    const conversation = sanitizeSegment(input.conversationId) || 'session';
    const identityHash = createHash('sha256')
        .update(`${input.appId}\0${input.conversationId}`)
        .digest('hex')
        .slice(0, 12);
    const prefix = `app_${identityHash}_`;
    const remaining = 96 - prefix.length;
    const appPart = app.slice(0, Math.max(8, Math.floor(remaining * 0.4)));
    const conversationPart = conversation.slice(0, Math.max(8, remaining - appPart.length - 1));
    return {
        name: `${input.appId}:${input.conversationId}`,
        folder: `${prefix}${appPart}_${conversationPart}`.slice(0, 96),
        trigger: '',
        added_at: nowIso(),
        requiresTrigger: false,
    };
}
export function canAccessApp(auth, appId) {
    if (!appId)
        return false;
    return auth.appId === appId;
}
export function resolveAppScopeAppId(auth, assertedAppId) {
    return applicationResolveAppScopeAppId({
        apiKeyAppId: auth.appId,
        assertedAppId,
    });
}
export async function resolveJobAppSession(control, job, appId) {
    if (!job.session_id)
        return undefined;
    const session = await control.getAppSessionById(job.session_id);
    if (session?.appId !== appId)
        return undefined;
    return {
        sessionId: session.sessionId,
        appId: session.appId,
        conversationJid: session.chatJid,
        workspaceKey: session.workspaceKey,
        defaultResponseMode: session.defaultResponseMode,
        defaultWebhookId: session.defaultWebhookId,
    };
}
export function mapManualJobToStored(job, metadata, options = { detail: true }) {
    const isManual = job.schedule_type === 'manual';
    const modelUseKind = modelUseKindForJobSchedule(job.schedule_type);
    const defaultConfig = options.getDefaultModelConfig?.(modelUseKind, job.workspace_key) ?? {
        model: job.model ?? undefined,
        source: job.model ? 'job.model' : 'inherited',
    };
    const agentHarness = options.getSelectedAgentHarness?.(job.workspace_key);
    const resolvedModel = resolveJobModel(job, defaultConfig, agentHarness);
    const resolvedAlias = resolvedModel.resolution?.ok
        ? resolvedModel.resolution.alias
        : (resolvedModel.selectedModel ?? null);
    const detail = options.detail !== false;
    return {
        jobId: job.id,
        name: job.name,
        ...(detail ? { prompt: job.prompt } : {}),
        promptPreview: metadata.promptPreview,
        ...(detail ? { fullPrompt: metadata.fullPrompt ?? job.prompt } : {}),
        kind: isManual
            ? 'manual'
            : job.schedule_type === 'once'
                ? 'once'
                : 'recurring',
        status: job.status,
        schedule: isManual
            ? null
            : job.schedule_type === 'once'
                ? { type: 'once', runAt: job.schedule_value }
                : {
                    type: job.schedule_type,
                    value: job.schedule_value,
                },
        executionContext: {
            conversationJid: metadata.executionContext.conversationJid,
            threadId: metadata.executionContext.threadId,
            workspaceKey: metadata.executionContext.workspaceKey,
            sessionId: metadata.executionContext.sessionId,
        },
        notificationRoutes: metadata.notificationRoutes,
        ownerLabel: metadata.ownerLabel,
        deliveryLabel: metadata.deliveryLabel,
        setupLabel: metadata.setupLabel,
        nextActionLabel: metadata.nextActionLabel,
        accessRequirements: job.access_requirements ?? [],
        setup: metadata.setup,
        recovery: metadata.recovery,
        nextRun: job.next_run,
        lastRun: job.last_run,
        staleness: metadata.staleness,
        health: metadata.health,
        modelAlias: job.model ?? null,
        modelSelection: {
            alias: resolvedAlias,
            source: job.model ? 'explicit' : resolvedModel.source,
            explicit: Boolean(job.model),
        },
        model: resolvedModel.entry
            ? {
                displayName: resolvedModel.entry.displayName,
                responseFamily: resolvedModel.entry.responseFamily,
                modelRoute: {
                    id: resolvedModel.entry.modelRoute.id,
                    label: resolvedModel.entry.modelRoute.label,
                },
                contextWindowTokens: resolvedModel.entry.contextWindowTokens,
                maxOutputTokens: resolvedModel.entry.maxOutputTokens,
                cachePolicy: resolvedModel.entry.cacheMode,
            }
            : null,
        workspaceKey: job.workspace_key,
        sessionId: job.session_id,
        target: metadata.target
            ? {
                appId: metadata.target.appId,
                agentId: metadata.target.agentId,
                workspaceKey: metadata.target.workspaceKey,
                conversationJids: metadata.target.conversationJids,
                threadId: metadata.target.threadId,
            }
            : undefined,
        toolAccess: metadata.toolAccess,
        ...(detail
            ? {
                recentRunErrors: metadata.recentRunErrors,
            }
            : {}),
    };
}
