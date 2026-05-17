import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

import { denyMemoryBoundaryToolUse } from '../memory-boundary.js';
import { denyProtectedCapabilityToolUse } from './protected-capability-guard.js';
import { requestPermissionApproval } from './permission-callback.js';
import type {
  AgentRunnerInput,
  AgentRunnerToolAttemptOutput,
} from './types.js';
import { findModelByRunnerModel } from '../../shared/model-catalog.js';
import { validateAgentToolInput } from './agent-model-selection.js';
import { readLiveToolRules } from '../../shared/live-tool-rules.js';
import {
  permissionUpdateAllowedToolRules,
  persistentPermissionUpdates,
} from '../../shared/permission-tool-rules.js';
import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../shared/tool-execution-policy-service.js';
import {
  permissionRequestToolName,
  scheduledPermissionSuggestions,
} from './permission-suggestions.js';
import { sandboxBlockedRuntimeEvents } from './sandbox-events.js';
import { createSdkSandboxNetworkGate } from './sdk-sandbox-network-gate.js';
import { readExternalMcpAllowedTools } from './external-mcp-tool-rules.js';
import { applyBashTrustEnv } from './bash-trust-env.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { evaluateYoloModeDenylist } from '../../shared/yolo-mode-policy.js';
import {
  emitJobToolActivity,
  emitYoloDenylistHit,
  yoloDenylistPromptReason,
} from './tool-permission-events.js';
import { waitOnlyBashMonitoringDenial } from './wait-only-bash-guard.js';
import { forceBackgroundNativeAgentInput } from './native-agent-tool-input.js';
import { denyNonPromptableAutonomousRecovery } from './autonomous-permission-recovery.js';

type PermissionApprovalInput = Parameters<typeof requestPermissionApproval>[0];

const GROUP_FOLDER_KEY =
  `${'group'}${'Folder'}` as keyof PermissionApprovalInput;
const TIMED_GRANT_DURATION_MS = 5 * 60 * 1000;
const TIMED_GRANT_CLOCK_SKEW_MS = 10_000;

interface TimedToolGrant {
  expiresAt: number;
}

interface RunnerCapabilitiesForPermission {
  allowedTools: readonly string[];
  alwaysAllowedTools: readonly string[];
}

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

function stableTimedGrantKey(value: unknown): string {
  return JSON.stringify(stableTimedGrantValue(value));
}

function stableTimedGrantValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableTimedGrantValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = stableTimedGrantValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function createCanUseToolCallback(
  input: CreateCanUseToolCallbackInput,
): CanUseTool {
  const currentModel = findModelByRunnerModel(input.configuredModel);
  const toolExecutionClassifier = new ToolExecutionClassifier();
  const toolExecutionPolicy = new ToolExecutionPolicyService();
  const liveApprovedRules = new Set<string>();
  const timedToolGrants = new Map<string, TimedToolGrant>();
  const sdkSandboxNetworkGate = createSdkSandboxNetworkGate(input.agentInput);
  const timedGrantConversationJid = input.agentInput.chatJid;

  const effectiveTimedGrantPrincipal = (): string =>
    input.agentInput.agentId || input.workspaceFolder;

  const timedGrantKey = (principal: string): string =>
    stableTimedGrantKey({
      principal,
      conversationJid: timedGrantConversationJid,
    });

  const isTimedGrantActive = (toolName: string, principal: string): boolean => {
    const key = timedGrantKey(principal);
    const grant = timedToolGrants.get(key);
    if (!grant) return false;
    if (grant.expiresAt <= Date.now()) {
      timedToolGrants.delete(key);
      return false;
    }
    log(
      `Timed grant honored for tool ${toolName}: scope=all_tools principal=${principal} conversationJid=${timedGrantConversationJid} ttlMs=${grant.expiresAt - Date.now()}`,
    );
    return true;
  };

  const rememberTimedGrant = (
    toolName: string,
    principal: string,
    requestedExpiresAtMs: number,
  ): void => {
    const now = Date.now();
    const maxExpiresAt =
      now + TIMED_GRANT_DURATION_MS + TIMED_GRANT_CLOCK_SKEW_MS;
    if (
      !Number.isFinite(requestedExpiresAtMs) ||
      requestedExpiresAtMs <= now ||
      requestedExpiresAtMs > maxExpiresAt
    ) {
      log(
        `Ignored invalid timed grant for tool ${toolName}: principal=${principal} requestedExpiresAt=${requestedExpiresAtMs}`,
      );
      return;
    }
    const grant: TimedToolGrant = {
      expiresAt: requestedExpiresAtMs,
    };
    timedToolGrants.set(timedGrantKey(principal), grant);
    sdkSandboxNetworkGate.rememberGlobalApproval(
      principal,
      requestedExpiresAtMs,
    );
    log(
      `Timed grant activated for tool ${toolName}: scope=all_tools principal=${principal} conversationJid=${timedGrantConversationJid} expiresAt=${new Date(requestedExpiresAtMs).toISOString()}`,
    );
  };

  const currentAllowedToolRules = (): string[] => [
    ...(input.agentInput.allowedTools ?? []),
    ...input.capabilities.allowedTools,
    ...readLiveToolRules({
      ipcDir: process.env.MYCLAW_IPC_DIR,
      runHandle: process.env.MYCLAW_AGENT_RUN_HANDLE,
    }),
    ...liveApprovedRules,
  ];

  const currentAutonomousAllowedToolRules = (): string[] => [
    ...(input.agentInput.allowedTools ?? []),
    ...readExternalMcpAllowedTools(),
    ...readLiveToolRules({
      ipcDir: process.env.MYCLAW_IPC_DIR,
      runHandle: process.env.MYCLAW_AGENT_RUN_HANDLE,
    }),
    ...liveApprovedRules,
  ];

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
        requestedToolName: toolName,
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
        suggestions: scheduledPermissionSuggestions(
          toolName,
          permissionOpts.suggestions,
          {
            blockedPath: permissionOpts.blockedPath,
            toolInput,
          },
        ),
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
      applyBashTrustEnv(toolName, toolInput, input.sdkEnv);
    const timedGrantPrincipal = effectiveTimedGrantPrincipal();
    const sdkApprovalPrincipal =
      permissionOpts.agentID?.trim() || timedGrantPrincipal;
    const rememberAllowedTool = () =>
      sdkSandboxNetworkGate.rememberAllowedTool(
        toolName,
        toolInput,
        permissionOpts,
        sdkApprovalPrincipal,
      );
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
      rememberAllowedTool();
      return { behavior: 'allow' as const, updatedInput: trustInput() };
    };

    if (toolName === 'Agent' || toolName === 'Task') {
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
    const sandboxNetworkAccessDecision = sdkSandboxNetworkGate.decide(
      toolName,
      toolInput,
      permissionOpts,
      sdkApprovalPrincipal,
    );
    if (sandboxNetworkAccessDecision) return sandboxNetworkAccessDecision;

    let timedGrantDenylistReason: string | undefined;
    if (isTimedGrantActive(toolName, timedGrantPrincipal)) {
      const yoloDenylistHit = evaluateYoloModeDenylist({
        settings: input.agentInput.yoloMode,
        toolName,
        toolInput,
      });
      if (yoloDenylistHit) {
        timedGrantDenylistReason = yoloDenylistPromptReason(yoloDenylistHit);
        log(
          `Timed grant bypass skipped for tool ${toolName}: ${timedGrantDenylistReason}`,
        );
        emitYoloDenylistHit({
          agentInput: input.agentInput,
          getNewSessionId: input.getNewSessionId,
          match: yoloDenylistHit,
          principal: timedGrantPrincipal,
        });
      } else {
        log(`Timed grant auto-allow for tool ${toolName}`);
        return allowToolUse('timed_grant');
      }
    }

    const toolExecutionRequest = toolExecutionClassifier.classify({
      origin: 'sdk',
      toolName,
      toolInput,
      executionMode: input.agentInput.isScheduledJob
        ? 'autonomous'
        : 'interactive',
      runContext: {
        jobId: input.agentInput.isScheduledJob
          ? input.agentInput.jobId
          : undefined,
        threadId: input.agentInput.threadId,
        conversationId: input.agentInput.chatJid,
      },
    });

    if (input.agentInput.isScheduledJob) {
      const toolDecision = toolExecutionPolicy.evaluate({
        request: toolExecutionRequest,
        autonomousAllowedToolRules: currentAutonomousAllowedToolRules(),
      });
      if (!timedGrantDenylistReason && toolDecision.status === 'allow') {
        log(`Autonomous run allowed tool ${toolName}: ${toolDecision.reason}`);
        return allowToolUse(toolDecision.reason);
      }
      if (permissionOpts.signal.aborted) {
        return {
          behavior: 'deny' as const,
          message: 'Permission request aborted',
          interrupt: true,
        };
      }
      const recoveryMessage =
        timedGrantDenylistReason ??
        (toolDecision.status === 'allow'
          ? toolDecision.reason
          : `${toolDecision.reason} Recovery: ${toolDecision.recoveryAction}`);
      const recoveryAction =
        toolDecision.status === 'allow'
          ? undefined
          : toolDecision.recoveryAction;
      if (!timedGrantDenylistReason) {
        const nonPromptableDenial = denyNonPromptableAutonomousRecovery({
          agentInput: input.agentInput,
          getNewSessionId: input.getNewSessionId,
          recoveryAction,
          recoveryMessage,
          toolName,
          toolPolicyReason: toolDecision.reason,
        });
        if (nonPromptableDenial) return nonPromptableDenial;
      }
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
          reason: toolDecision.reason,
          ...(recoveryAction ? { recovery_action: recoveryAction } : {}),
        },
      );
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
          timedGrantDenylistReason ??
          permissionOpts.decisionReason ??
          toolDecision.reason,
        closestRule:
          timedGrantDenylistReason || toolDecision.status === 'allow'
            ? undefined
            : toolDecision.closestRule,
        blockedPath: permissionOpts.blockedPath,
        toolInput,
        toolUseID: permissionOpts.toolUseID,
        agentID: permissionOpts.agentID,
        suggestions: scheduledPermissionSuggestions(
          toolName,
          permissionOpts.suggestions,
          { blockedPath: permissionOpts.blockedPath, toolInput },
        ),
        threadId: input.agentInput.threadId,
        [GROUP_FOLDER_KEY]: input.workspaceFolder,
      } as PermissionApprovalInput);
      if (decision.approved) {
        const persistentUpdates = persistentPermissionUpdates(decision);
        for (const rule of permissionUpdateAllowedToolRules(
          persistentUpdates,
        )) {
          liveApprovedRules.add(rule);
        }
        if (
          decision.mode === 'allow_timed_grant' &&
          typeof decision.timedGrantExpiresAtMs === 'number'
        ) {
          rememberTimedGrant(
            toolName,
            timedGrantPrincipal,
            decision.timedGrantExpiresAtMs,
          );
        }
        rememberAllowedTool();
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
          updatedInput: applyBashTrustEnv(toolName, toolInput, input.sdkEnv),
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
      !timedGrantDenylistReason &&
      input.capabilities.alwaysAllowedTools.includes(toolName)
    ) {
      return allowToolUse('always_allowed');
    }
    const currentToolDecision = toolExecutionPolicy.evaluate({
      request: toolExecutionRequest,
      allowedToolRules: currentAllowedToolRules(),
    });
    if (!timedGrantDenylistReason && currentToolDecision.status === 'allow') {
      log(
        `Permission allowed for tool ${toolName}: ${currentToolDecision.reason}`,
      );
      return allowToolUse(currentToolDecision.reason);
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
        reason: timedGrantDenylistReason ?? currentToolDecision.reason,
      },
    );
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
      decisionReason: timedGrantDenylistReason ?? permissionOpts.decisionReason,
      closestRule: timedGrantDenylistReason
        ? undefined
        : currentToolDecision.closestRule,
      blockedPath: permissionOpts.blockedPath,
      toolInput,
      toolUseID: permissionOpts.toolUseID,
      agentID: permissionOpts.agentID,
      suggestions: scheduledPermissionSuggestions(
        toolName,
        permissionOpts.suggestions,
        {
          blockedPath: permissionOpts.blockedPath,
          toolInput,
        },
      ),
      threadId: input.agentInput.threadId,
      [GROUP_FOLDER_KEY]: input.workspaceFolder,
    } as PermissionApprovalInput);
    if (decision.approved) {
      const persistentUpdates = persistentPermissionUpdates(decision);
      for (const rule of permissionUpdateAllowedToolRules(persistentUpdates)) {
        liveApprovedRules.add(rule);
      }
      if (
        decision.mode === 'allow_timed_grant' &&
        typeof decision.timedGrantExpiresAtMs === 'number'
      ) {
        rememberTimedGrant(
          toolName,
          timedGrantPrincipal,
          decision.timedGrantExpiresAtMs,
        );
      }
      rememberAllowedTool();
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
        updatedInput: applyBashTrustEnv(toolName, toolInput, input.sdkEnv),
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
