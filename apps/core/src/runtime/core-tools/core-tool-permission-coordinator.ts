import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../../domain/types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { ToolPolicyDecision } from '../../shared/tool-execution-policy-service.js';
import { runDurablePermissionInteraction } from '../../application/interactions/durable-interaction-handler.js';
import {
  permissionDecisionEventType,
  permissionDecisionName,
  permissionTelemetryContext,
} from '../ipc-permission-telemetry.js';
import { coordinatePermissionDecision } from '../permission-decision-coordinator.js';

interface CoreToolPermissionDeps {
  context: {
    sourceAgentFolder: string;
    accessPreset?: 'full' | 'locked';
    fixedImageRestricted?: boolean;
  };
  requestPermissionApproval?: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
  onPermissionDecision?: (
    request: PermissionApprovalRequest,
    decision: PermissionApprovalDecision,
  ) => Promise<void> | void;
  onPermissionPromptStarted?: (
    request: PermissionApprovalRequest,
  ) => Promise<void> | void;
  onPermissionPromptFinished?: (
    request: PermissionApprovalRequest,
  ) => Promise<void> | void;
  durability?: Parameters<
    typeof runDurablePermissionInteraction
  >[0]['operations'];
}

export async function coordinateCoreToolPermission(input: {
  request: PermissionApprovalRequest;
  hardDenyReason?: string;
  reviewedRuleDecision: ToolPolicyDecision;
  deps: CoreToolPermissionDeps;
}): Promise<PermissionApprovalDecision> {
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
          await publishPermissionEvent(
            deps,
            request,
            RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
            permissionTelemetryContext(request, {
              sourceAgentFolder: deps.context.sourceAgentFolder,
              decision: 'requested',
            }),
          );
        },
        prompt: async () =>
          deps.requestPermissionApproval?.(request) ?? {
            approved: false,
            mode: 'cancel',
            reason: 'approval surface unavailable',
          },
        afterDecision: async (permissionDecision) => {
          await deps.onPermissionDecision?.(request, permissionDecision);
          await publishPermissionEvent(
            deps,
            request,
            permissionDecisionEventType(permissionDecision),
            permissionTelemetryContext(request, {
              sourceAgentFolder: deps.context.sourceAgentFolder,
              decision: permissionDecisionName(permissionDecision),
              decisionMode: permissionDecision.mode,
              decidedBy: permissionDecision.decidedBy,
            }),
          );
          if (permissionDecision.approved) {
            await publishPermissionEvent(
              deps,
              request,
              RUNTIME_EVENT_TYPES.PERMISSION_RESUMED,
              permissionTelemetryContext(request, {
                sourceAgentFolder: deps.context.sourceAgentFolder,
                decision: 'resumed',
                decisionMode: permissionDecision.mode,
              }),
            );
          }
          await publishPermissionEvent(
            deps,
            request,
            RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME,
            permissionTelemetryContext(request, {
              sourceAgentFolder: deps.context.sourceAgentFolder,
              decision: permissionDecisionName(permissionDecision),
              approved: permissionDecision.approved,
              decisionMode: permissionDecision.mode,
            }),
          );
          await deps.onPermissionPromptFinished?.(request);
        },
      });
      return interaction.resolved
        ? interaction.decision
        : {
            approved: false,
            mode: 'cancel' as const,
            reason: 'durable permission resolution failed',
          };
    },
  });
}

async function publishPermissionEvent(
  deps: CoreToolPermissionDeps,
  request: PermissionApprovalRequest,
  eventType: (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES],
  payload: Record<string, unknown>,
): Promise<void> {
  if (!deps.publishRuntimeEvent || !request.appId) return;
  await deps
    .publishRuntimeEvent({
      appId: request.appId as never,
      agentId: request.agentId as never,
      runId: request.runId as never,
      jobId: request.jobId as never,
      conversationId: request.targetJid as never,
      threadId: request.threadId as never,
      eventType,
      actor: 'permission',
      correlationId: request.requestId,
      payload,
    })
    .catch(() => undefined);
}
