import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { runDurablePermissionInteraction } from '../../application/interactions/durable-interaction-handler.js';
import { permissionDecisionEventType, permissionDecisionName, permissionTelemetryContext, } from '../ipc-permission-telemetry.js';
import { coordinatePermissionDecision } from '../permission-decision-coordinator.js';
export async function coordinateCoreToolPermission(input) {
    const { request, deps } = input;
    return coordinatePermissionDecision({
        request,
        hardDenyReason: input.hardDenyReason,
        accessPreset: deps.context.accessPreset,
        fixedImageRestricted: deps.context.fixedImageRestricted,
        reviewedRuleDecision: input.reviewedRuleDecision,
        tail: async () => {
            const interaction = await runDurablePermissionInteraction({
                request,
                sourceAgentFolder: deps.context.sourceAgentFolder,
                operations: deps.durability,
                beforePrompt: async () => {
                    await deps.onPermissionPromptStarted?.(request);
                    await publishPermissionEvent(deps, request, RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED, permissionTelemetryContext(request, {
                        sourceAgentFolder: deps.context.sourceAgentFolder,
                        decision: 'requested',
                    }));
                },
                prompt: async () => deps.requestPermissionApproval?.(request) ?? {
                    approved: false,
                    mode: 'cancel',
                    reason: 'approval surface unavailable',
                },
                afterDecision: async (permissionDecision) => {
                    await deps.onPermissionDecision?.(request, permissionDecision);
                    await publishPermissionEvent(deps, request, permissionDecisionEventType(permissionDecision), permissionTelemetryContext(request, {
                        sourceAgentFolder: deps.context.sourceAgentFolder,
                        decision: permissionDecisionName(permissionDecision),
                        decisionMode: permissionDecision.mode,
                        decidedBy: permissionDecision.decidedBy,
                    }));
                    if (permissionDecision.approved) {
                        await publishPermissionEvent(deps, request, RUNTIME_EVENT_TYPES.PERMISSION_RESUMED, permissionTelemetryContext(request, {
                            sourceAgentFolder: deps.context.sourceAgentFolder,
                            decision: 'resumed',
                            decisionMode: permissionDecision.mode,
                        }));
                    }
                    await publishPermissionEvent(deps, request, RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME, permissionTelemetryContext(request, {
                        sourceAgentFolder: deps.context.sourceAgentFolder,
                        decision: permissionDecisionName(permissionDecision),
                        approved: permissionDecision.approved,
                        decisionMode: permissionDecision.mode,
                    }));
                    await deps.onPermissionPromptFinished?.(request);
                },
            });
            return interaction.resolved
                ? interaction.decision
                : {
                    approved: false,
                    mode: 'cancel',
                    reason: 'durable permission resolution failed',
                };
        },
    });
}
async function publishPermissionEvent(deps, request, eventType, payload) {
    if (!deps.publishRuntimeEvent || !request.appId)
        return;
    await deps
        .publishRuntimeEvent({
        appId: request.appId,
        agentId: request.agentId,
        runId: request.runId,
        jobId: request.jobId,
        conversationId: request.targetJid,
        threadId: request.threadId,
        eventType,
        actor: 'permission',
        correlationId: request.requestId,
        payload,
    })
        .catch(() => undefined);
}
