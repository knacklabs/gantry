import { readJson, sendApplicationError, sendError, sendJson, } from '../http.js';
import { authorizeControlRequest, } from '../handler-context.js';
import { buildControlPlaneReadModelForRequest } from '../control-plane-request-model.js';
import { GuidedActionService } from '../../../application/guided-actions/guided-action-service.js';
import { GUIDED_ACTION_DESCRIPTORS, resolveControlPlaneGuidedAction, } from '../../../application/guided-actions/guided-action-model.js';
import { createJobManagementService } from './jobs.js';
const GUIDED_ACTION_TYPES = new Set(Object.keys(GUIDED_ACTION_DESCRIPTORS));
function isGuidedActionType(value) {
    return typeof value === 'string' && GUIDED_ACTION_TYPES.has(value);
}
/**
 * Build a clean `Record<string, string>` from an untrusted body value, keeping
 * only entries whose value is a string. Non-object input and non-string values
 * are silently dropped so a malformed `params` never aborts the request.
 */
function readStringParams(value) {
    if (typeof value !== 'object' || value === null)
        return {};
    const params = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string')
            params[key] = entry;
    }
    return params;
}
async function resolveGuidedActionRef(req, res, ctx, appId) {
    const body = (await readJson(req));
    if (body.action !== undefined && !isGuidedActionType(body.action)) {
        sendError(res, 400, 'INVALID_REQUEST', 'Unknown guided action');
        return null;
    }
    // When a caller names an action, it must supply the label too. Without this
    // guard a valid action with a missing label silently falls through to the
    // model-derived action — executing something the caller did not ask for.
    if (isGuidedActionType(body.action)) {
        if (typeof body.label !== 'string' || body.label.trim() === '') {
            sendError(res, 400, 'INVALID_REQUEST', 'label is required when action is provided');
            return null;
        }
        const params = readStringParams(body.params);
        return Object.keys(params).length > 0
            ? { type: body.action, label: body.label, params }
            : { type: body.action, label: body.label };
    }
    const model = await buildControlPlaneReadModelForRequest(ctx, appId);
    return resolveControlPlaneGuidedAction(model.nextAction);
}
export async function handleGuidedActionRoutes(req, res, ctx, pathname) {
    if (pathname === '/v1/guided-actions/preview' && req.method === 'POST') {
        const key = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
        if (!key)
            return true;
        const ref = await resolveGuidedActionRef(req, res, ctx, key.appId);
        if (!ref)
            return true;
        const service = new GuidedActionService();
        sendJson(res, 200, service.preview(ref));
        return true;
    }
    if (pathname === '/v1/guided-actions/execute' && req.method === 'POST') {
        const key = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
        if (!key)
            return true;
        const ref = await resolveGuidedActionRef(req, res, ctx, key.appId);
        if (!ref)
            return true;
        if (ref.type === 'resume_job') {
            const writeKey = authorizeControlRequest(req, res, ctx.keys, [
                'jobs:write',
            ]);
            if (!writeKey)
                return true;
            const jobId = ref.params?.jobId;
            if (!jobId) {
                sendJson(res, 200, { status: 'manual', instruction: ref.label });
                return true;
            }
            try {
                const result = await createJobManagementService(ctx).resumeJob({
                    jobId,
                    appId: key.appId,
                });
                sendJson(res, 200, result.resumed
                    ? {
                        status: 'done',
                        changed: `Resumed job ${jobId}.`,
                        savedTo: 'runtime state',
                        restartRequired: false,
                        nextAction: 'none',
                    }
                    : {
                        status: 'done',
                        changed: `Job ${jobId} still needs setup.`,
                        savedTo: 'runtime state',
                        restartRequired: false,
                        nextAction: result.job.setup_state?.blockers?.[0]?.nextAction ??
                            'Resolve job setup blockers.',
                    });
            }
            catch (err) {
                if (sendApplicationError(res, err))
                    return true;
                sendJson(res, 200, {
                    status: 'failed',
                    cause: err instanceof Error ? err.message : String(err),
                    recover: ref.label,
                });
            }
            return true;
        }
        const service = new GuidedActionService();
        sendJson(res, 200, await service.execute(ref));
        return true;
    }
    return false;
}
