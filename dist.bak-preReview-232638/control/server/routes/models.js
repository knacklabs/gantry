import { ModelDefaultsResponseSchema } from '@gantry/contracts';
import { ApplicationError } from '../../../application/common/application-error.js';
import { DEFAULT_SETUP_MODEL_ALIAS, listModelCatalogEntries, memoryModelDefaultsForProvider, resolveModelSelectionForWorkload, } from '../../../shared/model-catalog.js';
import { isModelFamilyAlias, resolveModelFamilyAlias, } from '../../../shared/model-families.js';
import { resolveModelCacheSupport } from '../../../shared/model-cache-support.js';
import { deriveAgentEngineForProvider, executionRoutesForEntry, memoryTransportLaneForModel, } from '../../../shared/model-execution-route.js';
import { agentEngineLabel, DEFAULT_AGENT_ENGINE, } from '../../../shared/agent-engine.js';
import { agentModelPreview } from './model-agent-preview.js';
import { createJobManagementService } from './jobs.js';
import { authorizeControlRequest, } from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import { authenticate } from '../auth.js';
function modelToResponse(entry, configuredProviders) {
    return {
        id: entry.id,
        displayName: entry.displayName,
        aliases: entry.aliases,
        recommendedAlias: entry.recommendedAlias,
        responseFamily: entry.responseFamily,
        executionRoutes: executionRoutesForEntry(entry),
        credentialProfileRef: entry.credentialProfileRef,
        modelRoute: {
            id: entry.modelRoute.id,
            label: entry.modelRoute.label,
            metadata: {
                providerModelId: entry.modelRoute.providerModelId,
            },
        },
        capabilities: entry.capabilities,
        supportedWorkloads: entry.supportedWorkloads,
        contextWindowTokens: entry.contextWindowTokens,
        maxOutputTokens: entry.maxOutputTokens,
        cacheMode: entry.cacheMode,
        cacheTokenFields: entry.cacheTokenFields,
        cacheSupport: resolveModelCacheSupport(entry),
        supportsThinking: entry.supportsThinking,
        supportsTools: entry.supportsTools,
        inputUsdPerMillionTokens: entry.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: entry.outputUsdPerMillionTokens,
        ...(configuredProviders
            ? { available: configuredProviders.has(entry.modelRoute.id) }
            : {}),
        source: entry.source,
        experimental: entry.experimental === true,
    };
}
function modelDefaultSlotToResponse(slot) {
    return {
        configuredAlias: slot.configuredAlias,
        effectiveAlias: slot.effectiveAlias,
        source: slot.source,
        inherited: slot.configuredAlias === null,
        workload: slot.workload,
        model: slot.modelEntry ? modelToResponse(slot.modelEntry) : null,
    };
}
function resolvedSelectionToResponse(input) {
    const resolution = input.selectedAlias
        ? resolveModelSelectionForWorkload(input.selectedAlias, input.workload)
        : undefined;
    return {
        configuredAlias: input.configuredAlias,
        effectiveAlias: resolution?.ok
            ? resolution.alias
            : (input.selectedAlias ?? null),
        source: input.source,
        inherited: input.inherited,
        workload: input.workload,
        model: resolution?.ok ? modelToResponse(resolution.entry) : null,
    };
}
function applicationErrorToPreviewResult(error) {
    if (!(error instanceof ApplicationError))
        return undefined;
    switch (error.code) {
        case 'NOT_FOUND':
            return {
                ok: false,
                status: 404,
                code: 'JOB_NOT_FOUND',
                message: error.message,
            };
        case 'FORBIDDEN':
            return {
                ok: false,
                status: 403,
                code: 'FORBIDDEN',
                message: error.message,
            };
        case 'INVALID_REQUEST':
            return {
                ok: false,
                status: 400,
                code: 'INVALID_REQUEST',
                message: error.message,
            };
        case 'UNAVAILABLE':
            return {
                ok: false,
                status: 503,
                code: 'UNAVAILABLE',
                message: error.message,
            };
        default:
            throw error;
    }
}
function chatRouteForPreview(ctx, body) {
    const routes = typeof ctx.app.getConversationRoutes === 'function'
        ? ctx.app.getConversationRoutes()
        : {};
    const conversationJid = typeof body.conversationJid === 'string' ? body.conversationJid.trim() : '';
    if (conversationJid) {
        return {
            route: routes[conversationJid],
            scope: conversationJid,
        };
    }
    const workspaceKey = typeof body.workspaceKey === 'string' ? body.workspaceKey.trim() : '';
    if (!workspaceKey)
        return undefined;
    return {
        route: Object.values(routes).find((route) => route.folder === workspaceKey || route.name === workspaceKey),
        scope: workspaceKey,
    };
}
function modelDefaultsResponse(ctx) {
    const defaults = ctx.getModelDefaults().defaults;
    const chat = modelDefaultSlotToResponse(defaults.chat);
    const oneTime = modelDefaultSlotToResponse(defaults.oneTime);
    const recurring = modelDefaultSlotToResponse(defaults.recurring);
    const memoryExtractor = modelDefaultSlotToResponse(defaults.memoryExtractor);
    const memoryDreaming = modelDefaultSlotToResponse(defaults.memoryDreaming);
    const memoryConsolidation = modelDefaultSlotToResponse(defaults.memoryConsolidation);
    const providerModel = defaults.chat.modelEntry ??
        defaults.oneTime.modelEntry ??
        defaults.recurring.modelEntry ??
        defaults.memoryExtractor.modelEntry;
    return ModelDefaultsResponseSchema.parse({
        provider: providerModel
            ? {
                id: providerModel.modelRoute.id,
                label: providerModel.modelRoute.label,
            }
            : null,
        chat,
        jobs: {
            oneTime,
            recurring,
        },
        memory: {
            mode: 'provider-managed',
            extractor: memoryExtractor,
            dreaming: memoryDreaming,
            consolidation: memoryConsolidation,
        },
        defaults: {
            chat,
            oneTime,
            recurring,
            memoryExtractor,
            memoryDreaming,
            memoryConsolidation,
        },
    });
}
function providerForAlias(value, workload, options = {}) {
    if (typeof value !== 'string' || value === 'inherit')
        return undefined;
    const configuredProviders = options.configuredProviders;
    const alias = isModelFamilyAlias(value)
        ? (resolveModelFamilyAlias(value, {
            isProviderConfigured: (providerId) => configuredProviders?.has(providerId) ?? false,
            order: options.familyOrder,
        })?.alias ?? value)
        : value;
    const resolved = resolveModelSelectionForWorkload(alias, workload);
    if (!resolved.ok)
        return undefined;
    return resolved.entry.modelRoute.id;
}
export function providersSelectedByPatch(body, defaults, options = {}) {
    let chatAlias = defaults.defaults.chat.effectiveAlias ?? DEFAULT_SETUP_MODEL_ALIAS;
    if ('chat' in body) {
        chatAlias =
            body.chat === null || body.chat === 'inherit'
                ? DEFAULT_SETUP_MODEL_ALIAS
                : typeof body.chat === 'string'
                    ? body.chat
                    : chatAlias;
    }
    // Inherited job defaults follow the patched chat alias.
    let oneTimeAlias = defaults.defaults.oneTime.configuredAlias ?? chatAlias;
    let recurringAlias = defaults.defaults.recurring.configuredAlias ?? chatAlias;
    if ('jobs' in body) {
        if (body.jobs === null || body.jobs === 'inherit') {
            oneTimeAlias = chatAlias;
            recurringAlias = chatAlias;
        }
        else if (typeof body.jobs === 'string') {
            oneTimeAlias = body.jobs;
            recurringAlias = body.jobs;
        }
    }
    if ('oneTime' in body) {
        oneTimeAlias =
            body.oneTime === null || body.oneTime === 'inherit'
                ? chatAlias
                : typeof body.oneTime === 'string'
                    ? body.oneTime
                    : oneTimeAlias;
    }
    if ('recurring' in body) {
        recurringAlias =
            body.recurring === null || body.recurring === 'inherit'
                ? chatAlias
                : typeof body.recurring === 'string'
                    ? body.recurring
                    : recurringAlias;
    }
    const chatProvider = providerForAlias(chatAlias, 'chat', options);
    const memoryDefaults = memoryModelDefaultsForProvider(chatProvider ??
        providerForAlias(DEFAULT_SETUP_MODEL_ALIAS, 'chat', options) ??
        '');
    const memoryAliases = 'memory' in body
        ? memoryDefaults
        : {
            extractor: defaults.defaults.memoryExtractor.effectiveAlias,
            dreaming: defaults.defaults.memoryDreaming.effectiveAlias,
            consolidation: defaults.defaults.memoryConsolidation.effectiveAlias,
        };
    return [
        [chatAlias, 'chat'],
        [oneTimeAlias, 'one_time_job'],
        [recurringAlias, 'recurring_job'],
        [memoryAliases.extractor, 'memory_extractor'],
        [memoryAliases.dreaming, 'memory_dreaming'],
        [memoryAliases.consolidation, 'memory_consolidation'],
    ].reduce((providers, [alias, workload]) => {
        const provider = providerForAlias(alias, workload, options);
        if (provider && !providers.includes(provider))
            providers.push(provider);
        return providers;
    }, []);
}
function authorizeModelPreviewRequest(req, res, ctx) {
    const sessionAuth = authenticate(req, ['sessions:read'], ctx.keys);
    if (sessionAuth.status === 'authenticated')
        return sessionAuth.key;
    const jobAuth = authenticate(req, ['jobs:read'], ctx.keys);
    if (jobAuth.status === 'authenticated')
        return jobAuth.key;
    if (sessionAuth.status === 'missing' ||
        sessionAuth.status === 'invalid' ||
        jobAuth.status === 'missing' ||
        jobAuth.status === 'invalid') {
        sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid API key');
        return null;
    }
    sendError(res, 403, 'FORBIDDEN', 'API key is missing required scope sessions:read or jobs:read');
    return null;
}
// Memory preview: the memory engine and transport lane derived from the memory
// model's provider/response family. The engine is no longer configured — it is
// read-only and follows the model's provider.
export function memoryModelPreview(ctx, body) {
    const defaults = ctx.getModelDefaults().defaults;
    const task = body.task === 'dreaming' || body.task === 'consolidation'
        ? body.task
        : 'extractor';
    const slot = task === 'dreaming'
        ? modelDefaultSlotToResponse(defaults.memoryDreaming)
        : task === 'consolidation'
            ? modelDefaultSlotToResponse(defaults.memoryConsolidation)
            : modelDefaultSlotToResponse(defaults.memoryExtractor);
    const responseFamily = slot.model?.responseFamily ?? null;
    const engine = slot.model
        ? deriveAgentEngineForProvider(slot.model.modelRoute.id)
        : DEFAULT_AGENT_ENGINE;
    const diagnosticLane = memoryTransportLaneForModel({
        providerId: slot.model?.modelRoute.id ?? null,
        responseFamily,
    });
    return {
        ok: true,
        body: {
            target: 'memory',
            task,
            selection: slot,
            engine,
            engineLabel: agentEngineLabel(engine),
            responseFamily,
            diagnosticLane,
            why: [
                `memory ${task} uses provider-managed settings from ${slot.source}`,
                `memory transport: ${agentEngineLabel(engine)}`,
            ],
        },
    };
}
async function previewResponse(ctx, body, auth) {
    const defaults = ctx.getModelDefaults().defaults;
    const target = String(body.target || '').trim();
    if (target === 'chat') {
        const scopedRoute = chatRouteForPreview(ctx, body);
        if (scopedRoute) {
            if (!scopedRoute.route) {
                return {
                    ok: false,
                    status: 404,
                    code: 'CONVERSATION_NOT_FOUND',
                    message: 'Conversation or workspace scope not found',
                };
            }
            const overrideAlias = scopedRoute.route.agentConfig?.model || null;
            const defaultConfig = ctx.getDefaultModelConfig('interactive', scopedRoute.route.folder);
            const slot = resolvedSelectionToResponse({
                configuredAlias: overrideAlias,
                selectedAlias: overrideAlias || defaultConfig.model || null,
                source: overrideAlias
                    ? 'conversation.agentConfig.model'
                    : defaultConfig.source,
                inherited: !overrideAlias,
                workload: 'chat',
            });
            return {
                ok: true,
                body: {
                    target,
                    scope: scopedRoute.scope,
                    selection: slot,
                    why: [
                        overrideAlias
                            ? `chat in ${scopedRoute.scope} uses a session /model override`
                            : `chat in ${scopedRoute.scope} inherits ${defaultConfig.source}`,
                    ],
                },
            };
        }
        const slot = modelDefaultSlotToResponse(defaults.chat);
        return {
            ok: true,
            body: {
                target,
                selection: slot,
                why: [`chat uses ${slot.source}`],
            },
        };
    }
    if (target === 'jobs' || target === 'job') {
        if (target === 'job' && typeof body.jobId === 'string') {
            const jobId = body.jobId.trim();
            if (!jobId) {
                return {
                    ok: false,
                    status: 400,
                    code: 'INVALID_REQUEST',
                    message: 'jobId is required for target "job".',
                };
            }
            let jobResult;
            try {
                jobResult = await createJobManagementService(ctx).getJob({
                    appId: auth.appId,
                    jobId,
                });
            }
            catch (error) {
                const mapped = applicationErrorToPreviewResult(error);
                if (mapped)
                    return mapped;
                throw error;
            }
            const { job } = jobResult;
            if (!job) {
                return {
                    ok: false,
                    status: 404,
                    code: 'JOB_NOT_FOUND',
                    message: 'Job not found',
                };
            }
            const modelKind = job.schedule_type === 'cron' || job.schedule_type === 'interval'
                ? 'recurringJob'
                : 'oneTimeJob';
            const workload = modelKind === 'recurringJob' ? 'recurring_job' : 'one_time_job';
            const defaultConfig = ctx.getDefaultModelConfig(modelKind, job.workspace_key);
            const selectedModel = job.model || defaultConfig.model;
            const resolution = selectedModel
                ? resolveModelSelectionForWorkload(selectedModel, workload)
                : undefined;
            const modelEntry = resolution?.ok ? resolution.entry : null;
            const alias = resolution?.ok ? resolution.alias : (selectedModel ?? null);
            return {
                ok: true,
                body: {
                    target,
                    jobId,
                    kind: modelKind === 'recurringJob' ? 'recurring' : 'one-time',
                    selection: {
                        configuredAlias: job.model ?? null,
                        effectiveAlias: alias,
                        source: job.model ? 'job.model' : defaultConfig.source,
                        inherited: !job.model,
                        workload,
                        model: modelEntry ? modelToResponse(modelEntry) : null,
                    },
                    why: [
                        job.model
                            ? `job ${jobId} uses explicit job.model`
                            : `job ${jobId} inherits ${defaultConfig.source}`,
                    ],
                },
            };
        }
        if (target === 'job') {
            return {
                ok: false,
                status: 400,
                code: 'INVALID_REQUEST',
                message: 'jobId is required for target "job".',
            };
        }
        const kind = body.kind === 'recurring' ? 'recurring' : 'one-time';
        const slot = kind === 'recurring'
            ? modelDefaultSlotToResponse(defaults.recurring)
            : modelDefaultSlotToResponse(defaults.oneTime);
        return {
            ok: true,
            body: {
                target,
                kind,
                selection: slot,
                why: [
                    slot.inherited
                        ? `${kind} jobs inherit chat/default model through ${slot.source}`
                        : `${kind} jobs use ${slot.source}`,
                ],
            },
        };
    }
    if (target === 'memory') {
        return memoryModelPreview(ctx, body);
    }
    if (target === 'agent') {
        return agentModelPreview(ctx, body);
    }
    return {
        ok: false,
        status: 400,
        code: 'INVALID_REQUEST',
        message: 'target must be chat, jobs, job, agent, or memory.',
    };
}
export async function handleModelRoutes(req, res, ctx, pathname) {
    if (pathname !== '/v1/models' &&
        pathname !== '/v1/models/defaults' &&
        pathname !== '/v1/models/preview') {
        return false;
    }
    if (pathname === '/v1/models/preview') {
        if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
            return true;
        }
        const auth = authorizeModelPreviewRequest(req, res, ctx);
        if (!auth)
            return true;
        const rawBody = await readJson(req);
        if (typeof rawBody !== 'object' ||
            rawBody === null ||
            Array.isArray(rawBody)) {
            sendError(res, 400, 'INVALID_REQUEST', 'Request body must be JSON.');
            return true;
        }
        const body = rawBody;
        if (body.target === 'job' && !auth.scopes.has('jobs:read')) {
            sendError(res, 403, 'FORBIDDEN', 'API key is missing required scope jobs:read');
            return true;
        }
        if (body.target !== 'job' && !auth.scopes.has('sessions:read')) {
            sendError(res, 403, 'FORBIDDEN', 'API key is missing required scope sessions:read');
            return true;
        }
        const preview = await previewResponse(ctx, body, auth);
        if (!preview.ok) {
            sendError(res, preview.status, preview.code, preview.message);
            return true;
        }
        sendJson(res, 200, preview.body);
        return true;
    }
    if (pathname === '/v1/models/defaults') {
        if (req.method === 'GET') {
            if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
                return true;
            }
            sendJson(res, 200, modelDefaultsResponse(ctx));
            return true;
        }
        if (req.method === 'PATCH') {
            const auth = authorizeControlRequest(req, res, ctx.keys, [
                'agents:admin',
            ]);
            if (!auth) {
                return true;
            }
            const rawBody = await readJson(req);
            if (typeof rawBody !== 'object' ||
                rawBody === null ||
                Array.isArray(rawBody)) {
                sendError(res, 400, 'INVALID_REQUEST', 'Request body must be JSON.');
                return true;
            }
            const body = rawBody;
            const appId = auth.appId;
            const configuredProviders = new Set(await ctx.getActiveModelCredentialProviderIds(appId));
            for (const provider of providersSelectedByPatch(body, ctx.getModelDefaults(), {
                configuredProviders,
                familyOrder: ctx.getInternalRuntimeSettings().modelFamilies,
            })) {
                const preflight = await ctx.preflightModelProvider(provider, appId);
                if (!preflight.ok) {
                    sendError(res, 400, 'INVALID_REQUEST', `Provider preflight failed: ${preflight.message}`);
                    return true;
                }
            }
            const result = await ctx.patchModelDefaults(body, appId, `control-api:${auth.kid}`, {
                getConfiguredModelProviderIds: async () => configuredProviders,
            });
            if (!result.ok) {
                sendError(res, 400, 'INVALID_REQUEST', result.message);
                return true;
            }
            sendJson(res, 200, modelDefaultsResponse(ctx));
            return true;
        }
        res.setHeader('Allow', 'GET, PATCH');
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        return true;
    }
    if (req.method === 'GET') {
        const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
        if (!auth) {
            return true;
        }
        const configuredProviders = new Set(await ctx.getActiveModelCredentialProviderIds(auth.appId));
        sendJson(res, 200, {
            models: listModelCatalogEntries().map((entry) => modelToResponse(entry, configuredProviders)),
        });
        return true;
    }
    res.setHeader('Allow', 'GET');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
}
