import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { denyMemoryBoundaryToolUse } from '../../../../shared/memory-boundary.js';
import { denyProtectedCapabilityToolUse } from './protected-capability-guard.js';
import { requestPermissionApproval } from './permission-callback.js';
import type {
  AgentRunnerInput,
  AgentRunnerToolAttemptOutput,
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
import { applyBashTrustEnv } from './bash-trust-env.js';
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
import { publicCapabilityAllowedToolRules } from '../../../../shared/agent-tool-references.js';
import { evaluateYoloModeDenylist } from '../../../../shared/yolo-mode-policy.js';
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
}
export function createCanUseToolCallback(
  input: CreateCanUseToolCallbackInput,
): CanUseTool {
  const currentModel = findModelByRunnerModel(input.configuredModel);
  const toolExecutionClassifier = new ToolExecutionClassifier();
  const toolExecutionPolicy = new ToolExecutionPolicyService();
  const liveApprovedRules = new Set<string>();
  const skillActionCapabilities = readRunnerSkillActionCapabilities();
  const currentAllowedToolRules = (): string[] => [
    ...(input.agentInput.allowedTools ?? []),
    ...publicCapabilityAllowedToolRules(input.capabilities.allowedTools),
    ...readLiveToolRules({
      ipcDir: process.env.GANTRY_IPC_DIR,
      runHandle: process.env.GANTRY_AGENT_RUN_HANDLE,
    }),
    ...liveApprovedRules,
  ];
  const currentAutonomousAllowedToolRules = (): string[] => [
    ...(input.agentInput.allowedTools ?? []),
    ...(input.agentInput.isScheduledJob ? ['RunCommand(date *)'] : []),
    ...readExternalMcpAllowedTools(),
    ...readLiveToolRules({
      ipcDir: process.env.GANTRY_IPC_DIR,
      runHandle: process.env.GANTRY_AGENT_RUN_HANDLE,
    }),
    ...liveApprovedRules,
  ];
  const lockedAccessPreset = input.capabilities.permissionMode === 'deny';
  const denyLockedToolUse = (toolName: string) => {
    const message =
      'capability not provisioned: this agent runs with a locked access preset and cannot request new tools, skills, MCP servers, or permissions. Provision the capability before the run.';
    log(`Permission auto-denied by locked access preset: tool=${toolName}`);
    emitJobToolActivity(
      input.agentInput,
      input.getNewSessionId,
      'deny',
      toolName,
      {
        ok: false,
        reason: message,
        decision: 'denied_by_profile',
      },
    );
    return {
      behavior: 'deny' as const,
      message,
      interrupt: false,
    };
  };
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
    const trustInput = () =>
      applyBashTrustEnv(
        toolName,
        toolInput,
        input.agentInput.toolNetworkEnv ?? {},
      );
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
    if (sandboxNetworkAccessDecision) return sandboxNetworkAccessDecision;

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
      });
      if (toolDecision.status === 'allow' && !yoloDenylistReason) {
        log(`Autonomous run allowed tool ${toolName}: ${toolDecision.reason}`);
        return allowToolUse(toolDecision.reason);
      }
      if (lockedAccessPreset) {
        return denyLockedToolUse(toolName);
      }
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
        `${toolDecision.reason} Recovery: ${toolDecision.recoveryAction}`;
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
          {
            ok: true,
            mode: decision.mode,
            decided_by: decision.decidedBy ?? null,
          },
        );
        log(
          `Autonomous run permission approved for tool ${toolName} by ${decision.decidedBy || 'unknown'}`,
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

    if (
      !yoloDenylistReason &&
      input.capabilities.alwaysAllowedTools.includes(toolName)
    ) {
      return allowToolUse('always_allowed');
    }
    const currentToolDecision = toolExecutionPolicy.evaluate({
      request: toolExecutionRequest,
      allowedToolRules: currentAllowedToolRules(),
    });
    if (currentToolDecision.status === 'allow' && !yoloDenylistReason) {
      log(
        `Permission allowed for tool ${toolName}: ${currentToolDecision.reason}`,
      );
      return allowToolUse(currentToolDecision.reason);
    }
    if (lockedAccessPreset) {
      return denyLockedToolUse(toolName);
    }
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
        {
          ok: true,
          mode: decision.mode,
          decided_by: decision.decidedBy ?? null,
        },
      );
      log(
        `Permission approved for tool ${toolName} by ${decision.decidedBy || 'unknown'}`,
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
      message: `Permission denied: ${reason}`,
      interrupt: false,
      ...(decision.decisionClassification
        ? { decisionClassification: decision.decisionClassification as never }
        : {}),
    };
  };
}
