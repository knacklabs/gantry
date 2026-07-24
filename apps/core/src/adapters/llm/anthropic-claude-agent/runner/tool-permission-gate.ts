import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { denyMemoryBoundaryToolUse } from '../../../../shared/memory-boundary.js';
import { denyProtectedCapabilityToolUse } from './protected-capability-guard.js';
import { requestPermissionApproval } from './permission-callback.js';
import type {
  AgentRunnerInput,
  AgentRunnerToolAttemptOutput,
  PermissionDecision,
  RunnerCapabilitiesForPermission,
} from './types.js';
import { WORKSPACE_FOLDER_OPTION_KEY } from './types.js';
import { findModelByRunnerModel } from '../../../../shared/model-catalog.js';
import { validateAgentToolInput } from './agent-model-selection.js';
import { readLiveToolRules } from '../../../../shared/live-tool-rules.js';
import {
  permissionUpdateAllowedToolRules,
  persistentPermissionUpdates,
} from '../../../../shared/permission-tool-rules.js';
import {
  buildAgentToolExecutionRequest,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../../../shared/tool-execution-policy-service.js';
import {
  livePermissionRulesForUpdates,
  permissionRequestToolName,
  readRunnerSkillActionCapabilities,
  scheduledPermissionSuggestionPlan,
} from './permission-suggestions.js';
import { sandboxBlockedRuntimeEvents } from './sandbox-events.js';
import { decideSdkSandboxNetworkAccess } from './sdk-sandbox-network-gate.js';
import { readExternalMcpAllowedTools } from './external-mcp-tool-rules.js';
import { applyBashTrustEnvWithProvenance } from './bash-trust-env.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import {
  emitJobToolActivity,
  emitYoloDenylistHit,
  yoloDenylistPromptReason,
} from './tool-permission-events.js';
import { waitOnlyBashMonitoringDenial } from './wait-only-bash-guard.js';
import { forceBackgroundNativeAgentInput } from './native-agent-tool-input.js';
import { denyNonPromptableAutonomousRecovery } from './autonomous-permission-recovery.js';
import { evaluateYoloModeDenylist } from '../../../../shared/yolo-mode-policy.js';
import { formatPermissionDeniedMessage } from '../../../../shared/permission-decision-message.js';
type ApprovalInput = Parameters<typeof requestPermissionApproval>[0];
const WORKSPACE_FOLDER_KEY = WORKSPACE_FOLDER_OPTION_KEY as keyof ApprovalInput;
const RAW_REQ = /^(Agent|AskUserQuestion|TodoWrite)$/;
const REMOVED_NATIVE_SUBAGENT_TOOL =
  /^Task(Create|Get|List|Output|Stop|Update)?$/;

interface CreateCanUseToolCallbackInput {
  agentInput: AgentRunnerInput;
  sdkEnv: Record<string, string | undefined>;
  workspaceFolder: string;
  memoryBlock: string;
  configuredModel?: string;
  capabilities: RunnerCapabilitiesForPermission;
  primeToolAttempts: AgentRunnerToolAttemptOutput[];
  getNewSessionId: () => string | undefined;
  emitInteractionBoundary: () => void;
  recordToolActivity: (toolName: string) => void;
  recordPermissionApprovalContext?: (
    toolUseID: string,
    additionalContext: string,
  ) => void;
}

export function createPermissionApprovalContextChannel() {
  const pending = new Map<string, string>();
  const postToolUse: HookCallback = async (hookInput, toolUseID) => {
    if (
      hookInput.hook_event_name !== 'PostToolUse' &&
      hookInput.hook_event_name !== 'PostToolUseFailure'
    ) {
      return { continue: true };
    }
    const key = hookInput.tool_use_id || toolUseID;
    const additionalContext = key ? pending.get(key) : undefined;
    if (key) pending.delete(key);
    return additionalContext
      ? {
          continue: true,
          hookSpecificOutput: {
            hookEventName: hookInput.hook_event_name,
            additionalContext,
          },
        }
      : { continue: true };
  };
  return {
    record: (toolUseID: string, context: string) =>
      pending.set(toolUseID, context),
    postToolUse,
  };
}

export function createCanUseToolCallback(
  input: CreateCanUseToolCallbackInput,
): CanUseTool {
  const currentModel = findModelByRunnerModel(input.configuredModel);
  const toolExecutionClassifier = new ToolExecutionClassifier();
  const toolExecutionPolicy = new ToolExecutionPolicyService();
  const liveApprovedRules = new Set<string>();
  const skillActionCapabilities = readRunnerSkillActionCapabilities();
  // PERM-2 Task F: the agent's configured allowedTools and the composed
  // capability-profile allowedTools no longer fold into the worker-side policy
  // rules. Folding them let a tool merely present on the SDK allowedTools
  // surface mint a policy `allow` here, parallel to (and skipping) the host
  // coordinator. The only standing-allow authority is the coordinator's
  // reviewed selected-rule path and decision-memory (both host-side); the
  // worker keeps only live host-approved rules and in-session operator
  // approvals so every tool still crosses the coordinator once.
  const currentAllowedToolRules = (): string[] => [
    ...readLiveToolRules({
      ipcDir: process.env.GANTRY_IPC_DIR,
      runHandle: process.env.GANTRY_AGENT_RUN_HANDLE,
    }),
    ...liveApprovedRules,
  ];
  const currentAutonomousAllowedToolRules = (): string[] => [
    ...(input.agentInput.isScheduledJob ? ['RunCommand(date *)'] : []),
    ...readExternalMcpAllowedTools(),
    ...readLiveToolRules({
      ipcDir: process.env.GANTRY_IPC_DIR,
      runHandle: process.env.GANTRY_AGENT_RUN_HANDLE,
    }),
    ...liveApprovedRules,
  ];
  const lockedAccessPreset = input.capabilities.permissionMode === 'deny';
  // Locked-preset and fixed-image agents run without the capability request
  // tools; recovery guidance must say "provision before the run" instead of
  // instructing a hidden request tool.
  const capabilityRequestToolsHidden =
    lockedAccessPreset || input.agentInput.hideAuthorityTools === true;
  return async (toolName, rawToolInput, permissionOpts) => {
    input.recordToolActivity(toolName);
    emitJobToolActivity(
      input.agentInput,
      input.getNewSessionId,
      'sdk_tool_request',
      toolName,
      {
        toolUseID: permissionOpts.toolUseID,
      },
    );
    const toolInput = forceBackgroundNativeAgentInput(toolName, rawToolInput);
    if (REMOVED_NATIVE_SUBAGENT_TOOL.test(toolName)) {
      const message =
        'Native SDK Task subagent tools are not supported. Use the Agent tool for native subagents, or request the Gantry AgentDelegation facade.';
      return { behavior: 'deny' as const, message, interrupt: false };
    }
    const waitOnlyDenial = waitOnlyBashMonitoringDenial(toolName, toolInput);
    if (waitOnlyDenial) {
      log(`Permission denied by wait-only Bash guard: ${waitOnlyDenial}`);
      emitJobToolActivity(
        input.agentInput,
        input.getNewSessionId,
        'deny',
        toolName,
        {
          ok: false,
          reason: waitOnlyDenial,
          decision: 'wait_only_bash_guard',
        },
      );
      return {
        behavior: 'deny' as const,
        message: waitOnlyDenial,
        interrupt: false,
      };
    }
    if (input.agentInput.runMode === 'prime') {
      const deniedReason =
        'Prime mode records requested tool access without executing tools.';
      const publicToolName = permissionRequestToolName(toolName);
      const attempt: AgentRunnerToolAttemptOutput = {
        runMode: 'prime',
        requestedToolName: RAW_REQ.test(toolName) ? publicToolName : toolName,
        toolName: publicToolName,
        title: permissionOpts.title,
        displayName:
          publicToolName === toolName
            ? permissionOpts.displayName
            : publicToolName,
        description: permissionOpts.description,
        decisionReason: permissionOpts.decisionReason,
        blockedPath: permissionOpts.blockedPath,
        toolUseID: permissionOpts.toolUseID,
        agentID: permissionOpts.agentID,
        toolInput,
        suggestions: scheduledPermissionSuggestionPlan(
          toolName,
          permissionOpts.suggestions,
          {
            blockedPath: permissionOpts.blockedPath,
            toolInput,
            semanticCapabilityDefinitions: skillActionCapabilities,
          },
        ).suggestions,
        deniedReason,
      };
      input.primeToolAttempts.push(attempt);
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: input.getNewSessionId(),
        primeToolAttempts: [attempt],
        runtimeEvents: [
          {
            appId: input.agentInput.appId,
            agentId: input.agentInput.agentId,
            runId: input.agentInput.runId,
            jobId: input.agentInput.jobId,
            conversationId: input.agentInput.chatJid,
            threadId: input.agentInput.threadId,
            eventType: RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED,
            actor: 'runner',
            responseMode: 'none',
            payload: attempt,
          },
        ],
      });
      return {
        behavior: 'deny' as const,
        message: deniedReason,
        interrupt: false,
      };
    }
    const trustedInput = applyBashTrustEnvWithProvenance(
      toolName,
      toolInput,
      input.agentInput.toolNetworkEnv ?? {},
    );
    const trustInput = () => trustedInput.toolInput;
    const sdkApprovalPrincipal =
      permissionOpts.agentID?.trim() ||
      input.agentInput.agentId ||
      input.workspaceFolder;
    const allowToolUse = (reason = 'allowed') => {
      emitJobToolActivity(
        input.agentInput,
        input.getNewSessionId,
        'allow',
        toolName,
        {
          ok: true,
          reason,
        },
      );
      return { behavior: 'allow' as const, updatedInput: trustInput() };
    };

    const sandboxNetworkAccessDecision = await decideSdkSandboxNetworkAccess({
      toolName,
      toolInput,
      denylist: input.agentInput.egressDenylist ?? [],
    });
    if (sandboxNetworkAccessDecision?.behavior === 'deny') {
      return sandboxNetworkAccessDecision;
    }

    if (toolName === 'Agent') {
      const modelDenial = validateAgentToolInput(toolInput, currentModel);
      if (modelDenial) {
        log(`Permission denied by model catalog guard: ${modelDenial}`);
        emitJobToolActivity(
          input.agentInput,
          input.getNewSessionId,
          'deny',
          toolName,
          {
            ok: false,
            reason: modelDenial,
            decision: 'model_catalog_guard',
          },
        );
        return {
          behavior: 'deny' as const,
          message: modelDenial,
          interrupt: false,
        };
      }
    }
    const protectedCapabilityDenial = denyProtectedCapabilityToolUse(
      toolName,
      toolInput,
      permissionOpts,
    );
    if (protectedCapabilityDenial) {
      log(
        `Permission denied by protected capability guard: ${protectedCapabilityDenial}`,
      );
      writeOutput({
        status: 'success',
        result: null,
        runtimeEvents: sandboxBlockedRuntimeEvents(input.agentInput, {
          toolName,
          reason: protectedCapabilityDenial,
          decision: 'protected_capability_denied',
        }),
      });
      emitJobToolActivity(
        input.agentInput,
        input.getNewSessionId,
        'deny',
        toolName,
        {
          ok: false,
          reason: protectedCapabilityDenial,
          decision: 'protected_capability_denied',
        },
      );
      return {
        behavior: 'deny' as const,
        message: protectedCapabilityDenial,
        interrupt: false,
      };
    }
    const memoryGuardDenial = denyMemoryBoundaryToolUse(
      toolName,
      toolInput,
      permissionOpts,
      input.memoryBlock,
    );
    if (memoryGuardDenial) {
      log(`Permission denied by memory boundary guard: ${memoryGuardDenial}`);
      emitJobToolActivity(
        input.agentInput,
        input.getNewSessionId,
        'deny',
        toolName,
        {
          ok: false,
          reason: memoryGuardDenial,
          decision: 'memory_boundary_guard',
        },
      );
      return {
        behavior: 'deny' as const,
        message: memoryGuardDenial,
        interrupt: false,
      };
    }
    const yoloDenylistMatch = evaluateYoloModeDenylist({
      settings: input.agentInput.yoloMode,
      toolName,
      toolInput,
    });
    const yoloDenylistReason = yoloDenylistMatch
      ? yoloDenylistPromptReason(yoloDenylistMatch)
      : undefined;
    if (yoloDenylistMatch && yoloDenylistReason) {
      emitYoloDenylistHit({
        agentInput: input.agentInput,
        getNewSessionId: input.getNewSessionId,
        match: yoloDenylistMatch,
        principal: sdkApprovalPrincipal,
        reason: yoloDenylistReason,
      });
    }

    const toolExecutionRequest = buildAgentToolExecutionRequest(
      toolExecutionClassifier,
      toolName,
      toolInput,
      {
        isScheduledJob: input.agentInput.isScheduledJob,
        jobId: input.agentInput.jobId,
        threadId: input.agentInput.threadId,
        conversationId: input.agentInput.chatJid,
      },
    );

    if (input.agentInput.isScheduledJob) {
      const toolDecision = toolExecutionPolicy.evaluate({
        request: toolExecutionRequest,
        autonomousAllowedToolRules: currentAutonomousAllowedToolRules(),
        capabilityRequestToolsHidden,
      });
      if (permissionOpts.signal.aborted) {
        return {
          behavior: 'deny' as const,
          message: 'Permission request aborted',
          interrupt: true,
        };
      }
      const recoveryAction = yoloDenylistReason
        ? undefined
        : toolDecision.recoveryAction;
      const recoveryMessage =
        yoloDenylistReason ??
        (toolDecision.recoveryAction
          ? `${toolDecision.reason} Recovery: ${toolDecision.recoveryAction}`
          : toolDecision.reason);
      const nonPromptableDenial = denyNonPromptableAutonomousRecovery({
        agentInput: input.agentInput,
        getNewSessionId: input.getNewSessionId,
        recoveryAction,
        recoveryMessage,
        toolName,
        toolPolicyReason: yoloDenylistReason ?? toolDecision.reason,
      });
      if (nonPromptableDenial) return nonPromptableDenial;
      const publicToolName = permissionRequestToolName(toolName);
      log(
        `Autonomous run requesting permission for tool ${toolName}: ${recoveryMessage}`,
      );
      input.emitInteractionBoundary();
      emitJobToolActivity(
        input.agentInput,
        input.getNewSessionId,
        'permission_wait',
        toolName,
        {
          ok: false,
          reason: yoloDenylistReason ?? toolDecision.reason,
          ...(recoveryAction ? { recovery_action: recoveryAction } : {}),
        },
      );
      const permissionPlan = scheduledPermissionSuggestionPlan(
        toolName,
        permissionOpts.suggestions,
        {
          blockedPath: permissionOpts.blockedPath,
          toolInput,
          semanticCapabilityDefinitions: skillActionCapabilities,
        },
      );
      // Same as the interactive branch: a denylist-triggered prompt must not
      // offer a future grant the denylist would never honor.
      const suggestions = yoloDenylistReason
        ? undefined
        : permissionPlan.suggestions;
      const decision = await requestPermissionApproval({
        appId: input.agentInput.appId,
        agentId: input.agentInput.agentId,
        targetJid: input.agentInput.chatJid,
        toolName: publicToolName,
        title: permissionOpts.title,
        displayName:
          publicToolName === toolName
            ? permissionOpts.displayName
            : publicToolName,
        description: permissionOpts.description,
        decisionReason:
          yoloDenylistReason ??
          permissionOpts.decisionReason ??
          toolDecision.reason,
        closestRule: yoloDenylistReason ? undefined : toolDecision.closestRule,
        blockedPath: permissionOpts.blockedPath,
        toolInput,
        toolUseID: permissionOpts.toolUseID,
        agentID: permissionOpts.agentID,
        suggestions,
        semanticCapabilityDefinitions:
          permissionPlan.semanticCapabilityDefinitions,
        decisionOptions: permissionUpdateAllowedToolRules(suggestions).length
          ? ['allow_once', 'allow_persistent_rule', 'cancel']
          : ['allow_once', 'cancel'],
        threadId: input.agentInput.threadId,
        [WORKSPACE_FOLDER_KEY]: input.workspaceFolder,
      } as unknown as ApprovalInput);
      if (decision.approved) {
        const persistentUpdates = persistentPermissionUpdates(decision);
        for (const rule of livePermissionRulesForUpdates(
          persistentUpdates,
          permissionPlan,
        )) {
          liveApprovedRules.add(rule);
        }
        emitJobToolActivity(
          input.agentInput,
          input.getNewSessionId,
          'permission_allowed',
          toolName,
          permissionAllowedActivityPayload(decision),
        );
        logPermissionApproval(toolName, decision, 'Autonomous run permission');
        recordPermissionApprovalContext(
          input,
          permissionOpts.toolUseID,
          decision,
        );
        return {
          behavior: 'allow' as const,
          updatedInput: trustInput(),
          ...(persistentUpdates && persistentUpdates.length > 0
            ? { updatedPermissions: persistentUpdates as never }
            : {}),
          ...(decision.decisionClassification
            ? {
                decisionClassification:
                  decision.decisionClassification as never,
              }
            : {}),
        };
      }
      const reason = decision.reason || 'Denied by operator';
      const message = `Permission denied: ${reason}. ${recoveryMessage}`;
      log(`Autonomous run denied tool ${toolName}: ${message}`);
      emitJobToolActivity(
        input.agentInput,
        input.getNewSessionId,
        'permission_denied',
        toolName,
        {
          ok: false,
          reason,
          ...(recoveryAction ? { recovery_action: recoveryAction } : {}),
        },
      );
      return {
        behavior: 'deny' as const,
        message,
        interrupt: true,
        ...(decision.decisionClassification
          ? { decisionClassification: decision.decisionClassification as never }
          : {}),
      };
    }

    const currentToolDecision = toolExecutionPolicy.evaluate({
      request: toolExecutionRequest,
      allowedToolRules: currentAllowedToolRules(),
      capabilityRequestToolsHidden,
    });
    if (permissionOpts.signal.aborted) {
      return {
        behavior: 'deny' as const,
        message: 'Permission request aborted',
      };
    }
    const publicToolName = permissionRequestToolName(toolName);
    input.emitInteractionBoundary();
    emitJobToolActivity(
      input.agentInput,
      input.getNewSessionId,
      'permission_wait',
      toolName,
      {
        ok: false,
        reason: yoloDenylistReason ?? currentToolDecision.reason,
      },
    );
    const permissionPlan = scheduledPermissionSuggestionPlan(
      toolName,
      permissionOpts.suggestions,
      {
        blockedPath: permissionOpts.blockedPath,
        toolInput,
        semanticCapabilityDefinitions: skillActionCapabilities,
      },
    );
    // A denylist-triggered prompt must not offer "Allow for future": the
    // denylist keeps blocking rule-based auto-allows, so a persisted rule
    // would silently never be honored. Allow once / Cancel only.
    const suggestions = yoloDenylistReason
      ? undefined
      : permissionPlan.suggestions;
    const decision = await requestPermissionApproval({
      appId: input.agentInput.appId,
      agentId: input.agentInput.agentId,
      targetJid: input.agentInput.chatJid,
      toolName: publicToolName,
      title: permissionOpts.title,
      displayName:
        publicToolName === toolName
          ? permissionOpts.displayName
          : publicToolName,
      description: permissionOpts.description,
      decisionReason: yoloDenylistReason ?? permissionOpts.decisionReason,
      closestRule: yoloDenylistReason
        ? undefined
        : currentToolDecision.closestRule,
      blockedPath: permissionOpts.blockedPath,
      toolInput,
      toolUseID: permissionOpts.toolUseID,
      agentID: permissionOpts.agentID,
      suggestions,
      semanticCapabilityDefinitions:
        permissionPlan.semanticCapabilityDefinitions,
      threadId: input.agentInput.threadId,
      [WORKSPACE_FOLDER_KEY]: input.workspaceFolder,
    } as unknown as ApprovalInput);
    if (decision.approved) {
      const persistentUpdates = persistentPermissionUpdates(decision);
      for (const rule of livePermissionRulesForUpdates(
        persistentUpdates,
        permissionPlan,
      )) {
        liveApprovedRules.add(rule);
      }
      emitJobToolActivity(
        input.agentInput,
        input.getNewSessionId,
        'permission_allowed',
        toolName,
        permissionAllowedActivityPayload(decision),
      );
      logPermissionApproval(toolName, decision, 'Permission');
      recordPermissionApprovalContext(
        input,
        permissionOpts.toolUseID,
        decision,
      );
      return {
        behavior: 'allow' as const,
        updatedInput: trustInput(),
        ...(persistentUpdates && persistentUpdates.length > 0
          ? { updatedPermissions: persistentUpdates as never }
          : {}),
        ...(decision.decisionClassification
          ? {
              decisionClassification: decision.decisionClassification as never,
            }
          : {}),
      };
    }
    const reason = decision.reason || 'Denied by operator';
    log(`Permission denied for tool ${toolName}: ${reason}`);
    emitJobToolActivity(
      input.agentInput,
      input.getNewSessionId,
      'permission_denied',
      toolName,
      {
        ok: false,
        reason,
      },
    );
    return {
      behavior: 'deny' as const,
      message: formatPermissionDeniedMessage(decision, reason),
      interrupt: false,
      ...(decision.decisionClassification
        ? { decisionClassification: decision.decisionClassification as never }
        : {}),
    };
  };
}

const SILENT_ALLOW_DECIDERS = new Set([
  'birthright',
  'deterministic_read_only',
]);

function permissionAllowedActivityPayload(
  decision: PermissionDecision,
): Record<string, unknown> {
  const provenanceMessage = formatPermissionAllowedMessage(decision);
  return {
    ok: true,
    mode: decision.mode,
    ...(decision.decidedBy ? { decided_by: decision.decidedBy } : {}),
    ...(decision.risk_level ? { risk_level: decision.risk_level } : {}),
    ...(decision.risk_category
      ? { risk_category: decision.risk_category }
      : {}),
    ...(provenanceMessage
      ? { reason: provenanceMessage }
      : decision.reason
        ? { reason: decision.reason }
        : {}),
  };
}

function formatPermissionAllowedMessage(
  decision: PermissionDecision,
): string | undefined {
  if (decision.decidedBy && SILENT_ALLOW_DECIDERS.has(decision.decidedBy)) {
    return undefined;
  }
  if (!decision.decidedBy && !decision.risk_level) return undefined;
  return formatPermissionDeniedMessage(decision, '')
    .replace(/^Permission denied/, 'Permission allowed')
    .replace(/: $/, '');
}

function logPermissionApproval(
  toolName: string,
  decision: PermissionDecision,
  prefix: string,
): void {
  const provenanceMessage = formatPermissionAllowedMessage(decision);
  log(
    provenanceMessage
      ? `${prefix} for tool ${toolName}: ${provenanceMessage}`
      : `${prefix} approved for tool ${toolName}`,
  );
}

function recordPermissionApprovalContext(
  input: CreateCanUseToolCallbackInput,
  toolUseID: string | undefined,
  decision: PermissionDecision,
): void {
  const additionalContext = formatPermissionAllowedMessage(decision);
  if (!toolUseID || !additionalContext) return;
  input.recordPermissionApprovalContext?.(toolUseID, additionalContext);
}
