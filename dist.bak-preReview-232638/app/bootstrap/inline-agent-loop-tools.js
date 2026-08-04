import { randomUUID } from 'node:crypto';
import { dispatchCallableAgentTool, } from '../../application/core-tools/callable-agent-tools.js';
import { runDurablePermissionInteraction } from '../../application/interactions/durable-interaction-handler.js';
import { decisionForMode } from '../../domain/permission-decision.js';
import { reviewedMcpReadBindingsForRuntimeAccess } from '../../application/agents/agent-tool-runtime-rules.js';
import { synthesizeHostPermissionSuggestions } from '../../application/permissions/permission-suggestion-synthesis.js';
import { classifyMcpToolAuditError, summarizeMcpToolArgumentPayload, summarizeMcpToolError, } from '../../application/mcp/mcp-tool-audit.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { resolveWorkspaceFolderPath } from '../../platform/workspace-folder.js';
import { PERMISSION_CLASSIFIER_MAX_STRING_LENGTH as CLASSIFIER_MAX, consultPermissionClassifierBeforePrompt, permissionPromotionHintCount, recordHumanPermissionPromotionSignal, } from '../../runtime/permission-classifier.js';
import { resolveTurnSelectedMcpServerIds, resolveTurnSelectedSkillContext, resolveTurnSemanticCapabilities, resolveTurnToolPolicy, } from '../../runtime/group-run-context.js';
import { createCoreToolRegistry } from '../../runtime/core-tools/registry.js';
import { createCoreToolSchemas } from '../../runtime/core-tools/schemas.js';
import { permissionDecisionEventType, permissionDecisionName, permissionTelemetryContext, } from '../../runtime/ipc-permission-telemetry.js';
import { sanitizeIpcToolInput } from '../../runtime/ipc-tool-input-sanitization.js';
import { coordinatePermissionDecision } from '../../runtime/permission-decision-coordinator.js';
import { ToolExecutionClassifier, ToolExecutionPolicyService, } from '../../shared/tool-execution-policy-service.js';
import { resolveInlineCallableAgentManifest, } from './inline-callable-agent-tools.js';
import { isMcpErrorResult, isSuccessfulMcpActivity, } from './inline-agent-loop-mcp-activity.js';
import { publishInlinePermissionEvent } from './inline-agent-loop-permission-events.js';
import { createInlineAgentTaskLifecycle } from './inline-agent-task-lifecycle.js';
import { createInlineToolSuccessLedger } from './inline-tool-success-ledger.js';
let inlineCoreToolHostDeps;
export async function createInlineCoreToolsForRun(laneInput, support) {
    const deps = inlineCoreToolHostDeps;
    if (!deps)
        throw new Error('Inline core tool host is not configured.');
    return createInlineCoreTools(laneInput, support, await resolveInlineCallableAgentManifest(laneInput, deps.getAgentRepository(), deps.getPermissionRuntimeSettings().agents, deps.getConversationRoutes(), deps.getAgentAccessPreset(laneInput.group.folder) !== 'locked' &&
        deps.createTaskLifecycleBackend(laneInput) != null, deps.warn));
}
export function createInlineCoreTools(laneInput, support, callableAgentManifest = []) {
    const deps = inlineCoreToolHostDeps;
    if (!deps)
        throw new Error('Inline core tool host is not configured.');
    const run = laneInput.input;
    const activeRunId = laneInput.correlationRunId ?? run.runId;
    const permissionSettings = deps.getPermissionRuntimeSettings();
    const autoModeModel = permissionSettings.permissions.autoMode.model;
    const permissionRuntimeConfig = {
        ...(autoModeModel ? { autoModeModel } : {}),
        memoryExtractorModel: permissionSettings.memory.llm.models.extractor,
    };
    const approvedCapabilityIds = permissionSettings.agents?.[laneInput.group.folder]?.capabilities?.map(({ id }) => id) ?? [];
    const reviewedMcpReadBindings = reviewedMcpReadBindingsForRuntimeAccess({
        runtimeAccess: run.runtimeAccess,
        semanticCapabilities: run.semanticCapabilities,
    });
    const yoloMode = run.yoloMode ?? permissionSettings.permissions.yoloMode;
    const toolSuccessLedger = run.toolRules?.length
        ? createInlineToolSuccessLedger()
        : undefined;
    const taskLifecycleBackend = deps.createTaskLifecycleBackend(laneInput);
    const projectedCallableAgents = taskLifecycleBackend &&
        run.parentTaskId == null &&
        run.toolPolicyRules?.includes('AgentDelegation') &&
        run.hideAuthorityTools !== true &&
        deps.getAgentAccessPreset(laneInput.group.folder) !== 'locked'
        ? callableAgentManifest
        : [];
    const callableAgentTaskLifecycleBackend = projectedCallableAgents.length
        ? deps.createTaskLifecycleBackend(laneInput, 'AgentDelegation')
        : undefined;
    const registry = createCoreToolRegistry({
        context: {
            sourceAgentFolder: laneInput.group.folder,
            conversationId: run.chatJid,
            appId: run.appId,
            agentId: run.agentId,
            providerAccountId: laneInput.group.providerAccountId,
            threadId: run.threadId,
            runId: activeRunId,
            jobId: run.jobId,
            runLeaseToken: run.runLeaseToken,
            runLeaseFencingVersion: run.runLeaseFencingVersion,
            isScheduledJob: run.isScheduledJob,
            memoryDefaultScope: run.memoryDefaultScope,
            memoryUserId: run.memoryUserId,
            memoryBlock: run.memoryContextBlock,
            allowedToolRules: run.toolPolicyRules,
            ...(toolSuccessLedger
                ? { toolRules: run.toolRules, toolSuccessLedger }
                : {}),
            yoloMode,
            permissionMode: run.permissionMode,
            accessPreset: deps.getAgentAccessPreset(laneInput.group.folder),
            fixedImageRestricted: run.hideAuthorityTools === true,
        },
        sendMessage: deps.sendMessage,
        ...(deps.getFileArtifactStore
            ? { getFileArtifactStore: deps.getFileArtifactStore }
            : {}),
        requestUserAnswer: deps.requestUserAnswer,
        requestPermissionApproval: deps.requestPermissionApproval,
        publishRuntimeEvent: deps.publishRuntimeEvent,
        emitAgentOutput: laneInput.emitOutput,
        onPermissionPromptStarted: (request) => laneInput.jobActivity.beginPermissionRequest(request.requestId, request.toolName),
        onPermissionPromptFinished: (request) => laneInput.jobActivity.finishPermissionRequest(request.requestId),
        taskLifecycleBackend,
        ...(callableAgentTaskLifecycleBackend && projectedCallableAgents.length
            ? {
                callableAgentManifest: projectedCallableAgents,
                dispatchCallableAgent: (entry, args) => dispatchCallableAgentTool({
                    args,
                    entry,
                    backend: callableAgentTaskLifecycleBackend,
                    narration: {
                        sourceAgentFolder: laneInput.group.folder,
                        deps,
                        isScheduledJob: run.isScheduledJob === true,
                    },
                    revalidate: async (expected) => (await resolveInlineCallableAgentManifest(laneInput, deps.getAgentRepository(), deps.getPermissionRuntimeSettings().agents, deps.getConversationRoutes(), true, deps.warn)).some((current) => current.toolName === expected.toolName &&
                        current.targetAgentId === expected.targetAgentId),
                }),
            }
            : {}),
        evaluateToolPreChecks: support.evaluateToolPreChecks,
        evaluateToolPolicy: support.evaluateToolPolicy,
        formatMemorySearchResponse: support.formatMemorySearchResponse,
        formatMemoryWriteResponse: support.formatMemoryWriteResponse,
        schemas: createCoreToolSchemas(support.schemaFactory),
    });
    const classifier = new ToolExecutionClassifier();
    const policy = new ToolExecutionPolicyService();
    const recordThirdPartyMcpToolActivity = async (activity) => {
        const repository = deps.getMcpServerRepository();
        const appId = run.appId;
        if (!repository || !appId) {
            throw new Error('Inline MCP audit repository is unavailable.');
        }
        const capability = laneInput.mcpServers.find(({ name }) => name === activity.serverName);
        const resultClass = activity.resultClass ??
            (activity.outcome === 'success' && isMcpErrorResult(activity.result)
                ? 'failure'
                : undefined) ??
            (activity.outcome === 'failure'
                ? classifyMcpToolAuditError(activity.error)
                : activity.outcome);
        const payload = {
            serverName: activity.serverName,
            toolName: activity.toolName,
            requestedToolRule: `mcp__${activity.serverName}__${activity.toolName}`,
            resultClass,
            latencyMs: activity.latencyMs,
            argumentSummary: summarizeMcpToolArgumentPayload(activity.toolInput),
            ...(activity.structuredError
                ? { error: activity.structuredError }
                : activity.error
                    ? { error: summarizeMcpToolError(activity.error) }
                    : {}),
        };
        await repository.appendAuditEvent({
            id: `mcp-audit:${randomUUID()}`,
            appId: appId,
            agentId: run.agentId,
            serverId: capability?.serverId,
            bindingId: capability?.bindingId,
            eventType: 'tool_activity',
            actorId: 'inline-agent',
            metadata: payload,
            createdAt: new Date().toISOString(),
        });
        if (isSuccessfulMcpActivity(activity)) {
            toolSuccessLedger?.recordSuccess(`mcp__${activity.serverName}__${activity.toolName}`);
        }
        if (!deps.publishRuntimeEvent)
            return;
        await deps
            .publishRuntimeEvent({
            appId: appId,
            agentId: run.agentId,
            runId: activeRunId,
            eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
            actor: 'inline-agent',
            responseMode: 'none',
            payload,
        })
            .catch(() => undefined);
    };
    return {
        ...registry,
        authorizeThirdPartyMcpTool: async (name, toolInput, context) => {
            context?.signal?.throwIfAborted();
            const toolRuleDenial = toolSuccessLedger
                ? support.evaluateToolPreChecks({
                    toolName: name,
                    toolInput,
                    memoryBlock: run.memoryContextBlock ?? '',
                    yoloMode,
                    toolRules: run.toolRules,
                    successLedger: toolSuccessLedger,
                })
                : null;
            if (toolRuleDenial) {
                const error = toolRuleDenial.error ?? {
                    category: 'permission',
                    isRetryable: false,
                    message: toolRuleDenial.reason,
                };
                const [, serverName = '', toolName = name] = name.split('__');
                await recordThirdPartyMcpToolActivity({
                    serverName,
                    toolName,
                    toolInput,
                    outcome: 'failure',
                    latencyMs: 0,
                    resultClass: error.category === 'validation' ? 'invalid_request' : 'denied',
                    structuredError: error,
                });
                return {
                    allowed: false,
                    reason: JSON.stringify(error),
                };
            }
            const precheck = support.evaluateToolPreChecks({
                toolName: name,
                toolInput,
                memoryBlock: run.memoryContextBlock ?? '',
                yoloMode,
            });
            const decision = support.evaluateToolPolicy({
                classifier,
                policy,
                toolName: name,
                toolInput,
                context: {
                    conversationId: run.chatJid,
                    threadId: run.threadId,
                    jobId: run.jobId,
                    isScheduledJob: run.isScheduledJob,
                    yoloMode,
                },
                allowedToolRules: [
                    ...(run.toolPolicyRules ?? []),
                    ...laneInput.mcpServers.flatMap(({ autoApproveToolNames }) => autoApproveToolNames),
                ],
            });
            const permissionRequestId = `permission-${randomUUID()}`;
            const suggestions = synthesizeHostPermissionSuggestions(name, toolInput);
            const displayToolInput = sanitizeIpcToolInput(toolInput);
            const request = {
                requestId: permissionRequestId,
                requestFamily: 'tool',
                sourceAgentFolder: laneInput.group.folder,
                appId: run.appId,
                agentId: run.agentId,
                providerAccountId: laneInput.group.providerAccountId,
                jobId: run.jobId,
                runId: activeRunId,
                runLeaseToken: run.runLeaseToken,
                runLeaseFencingVersion: run.runLeaseFencingVersion,
                targetJid: run.chatJid,
                threadId: run.threadId,
                ...(!run.isScheduledJob && run.memoryUserId
                    ? { senderId: run.memoryUserId }
                    : {}),
                toolName: name,
                displayName: name,
                description: 'Call a selected remote MCP tool.',
                decisionReason: decision.reason,
                closestRule: decision.closestRule,
                toolInput: toolInput,
                toolInputSanitized: displayToolInput.altered,
                toolInputSanitizedPaths: displayToolInput.alteredPaths,
                suggestions,
            };
            const promotionRepository = deps.getPermissionPromotionRepository();
            const coordinatedDecision = await coordinatePermissionDecision({
                request,
                hardDenyReason: precheck?.reason,
                accessPreset: deps.getAgentAccessPreset(laneInput.group.folder),
                fixedImageRestricted: run.hideAuthorityTools === true,
                reviewedRuleDecision: decision,
                tail: async () => {
                    const promotion = promotionRepository
                        ? {
                            repository: promotionRepository,
                            offer: async (promotionRequest) => {
                                const interaction = await runDurablePermissionInteraction({
                                    request: promotionRequest,
                                    sourceAgentFolder: laneInput.group.folder,
                                    prompt: deps.requestPermissionApproval,
                                });
                                if (interaction.resolved)
                                    recordHumanPermissionPromotionSignal({
                                        repository: promotionRepository,
                                        appId: promotionRequest.appId,
                                        agentFolder: laneInput.group.folder,
                                        request: promotionRequest,
                                        decision: interaction.decision,
                                    });
                                return interaction;
                            },
                        }
                        : undefined;
                    let classifierDecision;
                    const classifierInput = sanitizeIpcToolInput(toolInput, CLASSIFIER_MAX);
                    if (deps.publishRuntimeEvent) {
                        classifierDecision = await consultPermissionClassifierBeforePrompt({
                            permissionMode: run.permissionMode,
                            requestFamily: 'tool',
                            appId: run.appId,
                            agentId: run.agentId,
                            agentFolder: laneInput.group.folder,
                            runId: activeRunId,
                            jobId: run.jobId,
                            conversationId: run.chatJid,
                            threadId: run.threadId,
                            correlationId: permissionRequestId,
                            actor: 'permission',
                            intentSource: 'operator_message',
                            turnIntentSummary: run.prompt,
                            canonicalToolName: name,
                            toolInput: classifierInput.toolInput,
                            toolInputRedactedPaths: classifierInput.redactedPaths,
                            toolInputTruncatedPaths: classifierInput.truncatedPaths,
                            policyDecisionReason: decision.reason,
                            approvedCapabilityIds,
                            workspaceRoot: resolveWorkspaceFolderPath(laneInput.group.folder),
                            reviewedMcpReadBindings,
                            yoloMode: permissionSettings.permissions.yoloMode,
                            suggestions,
                            ...(promotion ? { promotion } : {}),
                            classifierConfig: permissionRuntimeConfig,
                            signal: context?.signal,
                            publishRuntimeEvent: deps.publishRuntimeEvent,
                            classifierConsult: deps.classifierConsult,
                        });
                        if (classifierDecision?.decision === 'allow') {
                            return decisionForMode(request, 'allow_once', 'auto_classifier');
                        }
                    }
                    if (run.permissionMode !== 'ask' && run.isScheduledJob === true) {
                        return {
                            ...decisionForMode(request, 'cancel', 'runtime'),
                            reason: classifierDecision
                                ? `Classifier requested human approval: ${classifierDecision.reason}`
                                : 'This tool is not eligible for unattended auto-permission.',
                        };
                    }
                    const effectiveSuggestions = classifierDecision?.denylistHit
                        ? undefined
                        : suggestions;
                    const promotionHintCount = classifierDecision?.denylistHit
                        ? undefined
                        : (classifierDecision?.promotionHintCount ??
                            (await permissionPromotionHintCount({
                                promotion,
                                appId: run.appId,
                                agentFolder: laneInput.group.folder,
                                canonicalToolName: name,
                                toolInput,
                                suggestions,
                            })));
                    request.suggestions = effectiveSuggestions;
                    request.promotionHintCount = promotionHintCount;
                    request.decisionOptions = effectiveSuggestions
                        ? promotionHintCount
                            ? ['allow_persistent_rule', 'allow_once', 'cancel']
                            : ['allow_once', 'allow_persistent_rule', 'cancel']
                        : ['allow_once', 'cancel'];
                    const interaction = await runDurablePermissionInteraction({
                        request,
                        sourceAgentFolder: laneInput.group.folder,
                        beforePrompt: async () => {
                            laneInput.jobActivity.beginPermissionRequest(request.requestId, request.toolName);
                            await laneInput.emitOutput({
                                status: 'success',
                                result: null,
                                interactionBoundary: 'user_interaction',
                            });
                            await publishInlinePermissionEvent(deps, request, RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED, permissionTelemetryContext(request, {
                                sourceAgentFolder: laneInput.group.folder,
                                decision: 'requested',
                            }));
                        },
                        prompt: deps.requestPermissionApproval,
                        afterDecision: async (permissionDecision) => {
                            await publishInlinePermissionEvent(deps, request, permissionDecisionEventType(permissionDecision), permissionTelemetryContext(request, {
                                sourceAgentFolder: laneInput.group.folder,
                                decision: permissionDecisionName(permissionDecision),
                                decisionMode: permissionDecision.mode,
                                decidedBy: permissionDecision.decidedBy,
                            }));
                            if (permissionDecision.approved) {
                                await publishInlinePermissionEvent(deps, request, RUNTIME_EVENT_TYPES.PERMISSION_RESUMED, permissionTelemetryContext(request, {
                                    sourceAgentFolder: laneInput.group.folder,
                                    decision: 'resumed',
                                    decisionMode: permissionDecision.mode,
                                }));
                            }
                            await publishInlinePermissionEvent(deps, request, RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME, permissionTelemetryContext(request, {
                                sourceAgentFolder: laneInput.group.folder,
                                decision: permissionDecisionName(permissionDecision),
                                approved: permissionDecision.approved,
                                decisionMode: permissionDecision.mode,
                            }));
                            laneInput.jobActivity.finishPermissionRequest(request.requestId);
                        },
                    });
                    if (interaction.resolved)
                        recordHumanPermissionPromotionSignal({
                            repository: promotionRepository,
                            appId: request.appId,
                            agentFolder: laneInput.group.folder,
                            request,
                            decision: interaction.decision,
                        });
                    return interaction.resolved
                        ? interaction.decision
                        : {
                            approved: false,
                            mode: 'cancel',
                            reason: 'Remote MCP permission request was denied.',
                        };
                },
            });
            return coordinatedDecision.approved
                ? { allowed: true }
                : {
                    allowed: false,
                    reason: coordinatedDecision.reason ??
                        'Remote MCP permission request was denied.',
                };
        },
        recordThirdPartyMcpToolActivity,
    };
}
export function wireInlineAgentLoopTools(input) {
    const reject = (kind) => {
        input.warn({ kind }, 'Rejecting interaction IPC on a worker without live-turn callbacks');
        throw new Error('This worker cannot receive provider interaction callbacks. Retry on a live-turn worker.');
    };
    const requestPermissionApproval = (request) => input.interactionsEnabled
        ? input.channelWiring.requestPermissionApproval(request)
        : Promise.reject(reject('permission'));
    const requestUserAnswer = (request) => input.interactionsEnabled
        ? input.channelWiring.requestUserAnswer(request)
        : Promise.reject(reject('question'));
    inlineCoreToolHostDeps = {
        warn: input.warn,
        sendMessage: (jid, text, messageOptions) => input.channelWiring.sendMessage(jid, text, {
            durability: 'required',
            throwOnMissing: true,
            ...(messageOptions ? { messageOptions } : {}),
        }),
        ...(input.getFileArtifactStore
            ? { getFileArtifactStore: input.getFileArtifactStore }
            : {}),
        requestPermissionApproval,
        requestUserAnswer,
        getAgentAccessPreset: input.getAgentAccessPreset,
        getConversationRoutes: input.app.getConversationRoutes,
        getPermissionRuntimeSettings: input.getPermissionRuntimeSettings,
        getMcpServerRepository: input.getMcpServerRepository ?? (() => undefined),
        getAgentRepository: input.getAgentRepository ?? (() => undefined),
        getPermissionPromotionRepository: input.getPermissionPromotionRepository ?? (() => undefined),
        classifierConsult: input.classifierConsult,
        createTaskLifecycleBackend: (laneInput, authorityToolName) => createInlineAgentTaskLifecycle({
            laneInput,
            authorityToolName,
            repository: input.getAsyncTaskRepository?.(),
            runRepository: input.opsRepository,
            getConversationRoutes: input.app.getConversationRoutes,
            resolveExecutionProviderId: input.app.resolveExecutionProviderId,
            resolveRunAccess: async (agentId) => {
                const turnContext = laneInput.input.appId
                    ? { appId: laneInput.input.appId, agentId }
                    : undefined;
                const [toolPolicy, selectedSkills, semanticCapabilities] = await Promise.all([
                    resolveTurnToolPolicy(input, turnContext),
                    resolveTurnSelectedSkillContext(input, turnContext),
                    resolveTurnSemanticCapabilities(input, turnContext),
                ]);
                return {
                    toolPolicyRules: toolPolicy.toolPolicyRules,
                    runtimeAccess: toolPolicy.runtimeAccess,
                    attachedSkillSourceIds: selectedSkills.ids,
                    selectedSkillDisplays: selectedSkills.displays,
                    attachedMcpSourceIds: await resolveTurnSelectedMcpServerIds(input, turnContext),
                    semanticCapabilities,
                };
            },
            buildRunOptions: async (agentId) => ({
                credentialBroker: await input.app.getCredentialBroker(),
                skillRepository: input.getSkillRepository?.(),
                skillArtifactStore: input.getSkillArtifactStore?.(),
                skillContext: laneInput.input.appId
                    ? {
                        appId: laneInput.input.appId,
                        agentId,
                    }
                    : undefined,
                mcpServerRepository: input.getMcpServerRepository?.(),
                capabilitySecretRepository: input.getCapabilitySecretRepository?.(),
                mcpContext: laneInput.input.appId
                    ? {
                        appId: laneInput.input.appId,
                        agentId,
                    }
                    : undefined,
                mcpHostnameLookup: input.mcpHostnameLookup,
                mcpDnsValidationCache: input.getMcpDnsValidationCache?.(),
                publishRuntimeEvent: input.publishRuntimeEvent,
                executionAdapter: input.executionAdapter ?? input.app.executionAdapter,
                executionAdapters: input.executionAdapters ?? input.app.executionAdapters,
                runnerSandboxProvider: input.app.runnerSandboxProvider,
                asyncTaskRepositoryAvailable: Boolean(input.getAsyncTaskRepository?.()),
            }),
        }),
        ...(input.publishRuntimeEvent
            ? {
                publishRuntimeEvent: async (event) => {
                    await input.publishRuntimeEvent?.(event);
                },
            }
            : {}),
    };
    return { requestPermissionApproval, requestUserAnswer };
}
