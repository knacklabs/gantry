import {
  query,
  type EffortLevel,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { composeAgentCapabilities } from '../agent-capabilities.js';
import { denyMemoryBoundaryToolUse } from '../memory-boundary.js';
import { denyProtectedCapabilityToolUse } from './protected-capability-guard.js';
import { MessageStream } from './message-stream.js';
import {
  drainInteractionBoundaries,
  drainIpcInput,
  shouldClose,
} from './ipc-input.js';
import { SteeringDeliveryGate } from './steering-delivery-gate.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { requestPermissionApproval } from './permission-callback.js';
import {
  buildSdkFilesystemSandbox,
  readProtectedFilesystemPaths,
} from './filesystem-sandbox.js';
import { protectedCapabilityPreToolUseHook } from './protected-capability-hook.js';
import {
  discoverAdditionalDirectories,
  IPC_POLL_MS,
  WORKSPACE_GROUP_DIR,
} from './runtime-env.js';
import {
  buildRunnerSystemPrompt,
  includeGitInstructionsForPersona,
  readMemoryContextBlock,
} from './system-prompt.js';
import type {
  AgentRunnerInput,
  AgentRunnerToolAttemptOutput,
} from './types.js';
import {
  findModelByRunnerModel,
  normalizeModelUsage,
} from '../../shared/model-catalog.js';
import { validateAgentToolInput } from './agent-model-selection.js';
import { usageEventIdForMessage } from './query-usage-event-id.js';
import { readLiveToolRules } from '../../shared/live-tool-rules.js';
import { permissionUpdateAllowedToolRules } from '../../shared/permission-tool-rules.js';
import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../shared/tool-execution-policy-service.js';
import {
  permissionRequestToolName,
  scheduledPermissionSuggestions,
} from './permission-suggestions.js';
import {
  assertRequiredMcpServerReady,
  readExternalMcpServers,
} from './mcp-server-validation.js';
import { sandboxBlockedRuntimeEvents } from './sandbox-events.js';
import { createSdkSandboxNetworkGate } from './sdk-sandbox-network-gate.js';
import {
  readExternalMcpAllowedTools,
  readExternalMcpAlwaysAllowedTools,
} from './external-mcp-tool-rules.js';
import { applyBashTrustEnv } from './bash-trust-env.js';
import { startJobHeartbeat } from './job-heartbeat.js';
import { logUsage } from './usage-logging.js';
import { readContextUsage } from './context-usage.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
function forceBackgroundNativeAgentInput(
  toolName: string,
  input: unknown,
): Record<string, unknown> {
  if (toolName !== 'Agent' && toolName !== 'Task') {
    return input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { run_in_background: true };
  }
  return { ...(input as Record<string, unknown>), run_in_background: true };
}
export async function runQuery(
  prompt: string,
  mcpServerPath: string,
  agentInput: AgentRunnerInput,
  sdkEnv: Record<string, string | undefined>,
  configuredModel: string | undefined,
  queryThinking: ThinkingConfig | undefined,
  queryEffort: EffortLevel | undefined,
  enableIpcFollowups = true,
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  primeToolAttempts: AgentRunnerToolAttemptOutput[];
}> {
  const stream = new MessageStream();
  const queryRunId = randomUUID();
  const memoryBlock = readMemoryContextBlock(agentInput);
  stream.pushInitialPrompt(prompt, memoryBlock);
  let ipcPolling = true;
  let closedDuringQuery = false;
  const steeringGate = new SteeringDeliveryGate((text) => {
    log(`Piping IPC message at turn boundary (${text.length} chars)`);
    stream.pushContent(text);
  });
  const emitInteractionBoundary = () => {
    writeOutput({
      status: 'success',
      result: null,
      newSessionId,
      interactionBoundary: 'user_interaction',
    });
  };
  const pollRuntimeSignalsDuringQuery = () => {
    if (!ipcPolling) return;
    const interactionBoundaries = drainInteractionBoundaries();
    for (let i = 0; i < interactionBoundaries; i += 1) {
      emitInteractionBoundary();
    }
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      steeringGate.close();
      stream.end();
      ipcPolling = false;
      return;
    }
    if (enableIpcFollowups) {
      const messages = drainIpcInput();
      for (const text of messages) {
        const delivery = steeringGate.accept(text);
        if (delivery === 'buffered') {
          log(
            `Buffering IPC message until query turn boundary (${text.length} chars)`,
          );
        }
      }
    }
    setTimeout(pollRuntimeSignalsDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollRuntimeSignalsDuringQuery, IPC_POLL_MS);
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let sawPartialTextSinceLastResult = false;
  const primeToolAttempts: AgentRunnerToolAttemptOutput[] = [];
  const heartbeat = startJobHeartbeat({
    agentInput,
    writeOutput,
    getSessionId: () => newSessionId,
  });
  const systemPrompt = buildRunnerSystemPrompt(agentInput, memoryBlock);
  const extraDirs = discoverAdditionalDirectories();
  const protectedFilesystemPaths = readProtectedFilesystemPaths();
  const currentModel = findModelByRunnerModel(configuredModel);
  const workspaceFolder = agentInput.groupFolder;
  const capabilities = composeAgentCapabilities({
    mcpServerPath,
    chatJid: agentInput.chatJid,
    groupFolder: workspaceFolder,
    threadId: agentInput.threadId,
    memoryUserId: agentInput.memoryUserId,
    memoryDefaultScope: agentInput.memoryDefaultScope,
    memoryReviewerIsControlApprover: agentInput.memoryReviewerIsControlApprover,
    persona: agentInput.persona,
    browserProfileName: agentInput.browserProfileName,
    configuredAllowedTools: agentInput.allowedTools,
    selectedSkillIds: agentInput.selectedSkillIds,
    selectedMcpServerIds: agentInput.selectedMcpServerIds,
    ipcDir: process.env.MYCLAW_IPC_DIR,
    ipcAuthToken: process.env.MYCLAW_IPC_AUTH_TOKEN,
    browserIpcAuthToken: process.env.MYCLAW_BROWSER_IPC_AUTH_TOKEN,
    memoryIpcAuthToken: process.env.MYCLAW_MEMORY_IPC_AUTH_TOKEN,
    ipcResponseVerifyKey: process.env.MYCLAW_IPC_RESPONSE_VERIFY_KEY,
    ipcResponseKeyId: process.env.MYCLAW_IPC_RESPONSE_KEY_ID,
    externalMcpServers: readExternalMcpServers(),
    externalMcpAllowedTools: readExternalMcpAllowedTools(),
    externalMcpAlwaysAllowedTools: readExternalMcpAlwaysAllowedTools(),
  });
  const toolExecutionClassifier = new ToolExecutionClassifier();
  const toolExecutionPolicy = new ToolExecutionPolicyService();
  const liveApprovedRules = new Set<string>();
  const sdkSandboxNetworkGate = createSdkSandboxNetworkGate(agentInput);
  function currentAllowedToolRules(): string[] {
    return [
      ...(agentInput.allowedTools ?? []),
      ...capabilities.allowedTools,
      ...readLiveToolRules({
        ipcDir: process.env.MYCLAW_IPC_DIR,
        runHandle: process.env.MYCLAW_AGENT_RUN_HANDLE,
      }),
      ...liveApprovedRules,
    ];
  }
  function currentScheduledAllowedToolRules(): string[] {
    return [
      ...(agentInput.allowedTools ?? []),
      ...readExternalMcpAllowedTools(),
      ...readLiveToolRules({
        ipcDir: process.env.MYCLAW_IPC_DIR,
        runHandle: process.env.MYCLAW_AGENT_RUN_HANDLE,
      }),
      ...liveApprovedRules,
    ];
  }
  const sdkQuery = query({
    prompt: stream,
    options: {
      model: configuredModel,
      thinking: queryThinking,
      effort: queryEffort,
      cwd: WORKSPACE_GROUP_DIR,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      persistSession: !agentInput.isScheduledJob,
      resume:
        !agentInput.isScheduledJob && agentInput.sessionId
          ? agentInput.sessionId
          : undefined,
      systemPrompt,
      settings: {
        includeGitInstructions: includeGitInstructionsForPersona(
          agentInput.persona,
        ),
      },
      tools: [...capabilities.availableTools],
      allowedTools: [...capabilities.allowedTools],
      disallowedTools: [...capabilities.disallowedTools],
      env: sdkEnv,
      sandbox: buildSdkFilesystemSandbox(protectedFilesystemPaths),
      permissionMode: capabilities.permissionMode,
      hooks: {
        PreToolUse: [
          {
            hooks: [protectedCapabilityPreToolUseHook],
            timeout: 5,
          },
        ],
      },
      canUseTool: async (toolName, input, permissionOpts) => {
        heartbeat.recordToolActivity(toolName);
        const toolInput = forceBackgroundNativeAgentInput(toolName, input);
        if (agentInput.runMode === 'prime') {
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
          primeToolAttempts.push(attempt);
          writeOutput({
            status: 'success',
            result: null,
            newSessionId,
            primeToolAttempts: [attempt],
            runtimeEvents: [
              {
                appId: agentInput.appId,
                agentId: agentInput.agentId,
                runId: agentInput.runId,
                jobId: agentInput.jobId,
                conversationId: agentInput.chatJid,
                threadId: agentInput.threadId,
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
        const trustInput = () => applyBashTrustEnv(toolName, toolInput, sdkEnv);
        const rememberAllowedTool = () =>
          sdkSandboxNetworkGate.rememberAllowedTool(
            toolName,
            toolInput,
            permissionOpts,
          );
        const allowToolUse = () => {
          rememberAllowedTool();
          return { behavior: 'allow' as const, updatedInput: trustInput() };
        };
        if (toolName === 'Agent' || toolName === 'Task') {
          const modelDenial = validateAgentToolInput(toolInput, currentModel);
          if (modelDenial) {
            log(`Permission denied by model catalog guard: ${modelDenial}`);
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
            runtimeEvents: sandboxBlockedRuntimeEvents(agentInput, {
              toolName,
              reason: protectedCapabilityDenial,
              decision: 'protected_capability_denied',
            }),
          });
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
          memoryBlock,
        );
        if (memoryGuardDenial) {
          log(
            `Permission denied by memory boundary guard: ${memoryGuardDenial}`,
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
        );
        if (sandboxNetworkAccessDecision) return sandboxNetworkAccessDecision;
        const toolExecutionRequest = toolExecutionClassifier.classify({
          origin: 'sdk',
          toolName,
          toolInput,
          executionMode: agentInput.isScheduledJob
            ? 'autonomous'
            : 'interactive',
          runContext: {
            jobId: agentInput.isScheduledJob ? agentInput.jobId : undefined,
            threadId: agentInput.threadId,
            conversationId: agentInput.chatJid,
          },
        });
        if (agentInput.isScheduledJob) {
          const toolDecision = toolExecutionPolicy.evaluate({
            request: toolExecutionRequest,
            schedulerAllowedToolRules: currentScheduledAllowedToolRules(),
          });
          if (toolDecision.status === 'allow') {
            log(
              `Autonomous job allowed tool ${toolName}: ${toolDecision.reason}`,
            );
            return allowToolUse();
          }
          if (permissionOpts.signal.aborted) {
            return {
              behavior: 'deny' as const,
              message: 'Permission request aborted',
              interrupt: true,
            };
          }
          const recoveryMessage = `${toolDecision.reason} Recovery: ${toolDecision.recoveryAction}`;
          const publicToolName = permissionRequestToolName(toolName);
          log(
            `Autonomous job requesting permission for tool ${toolName}: ${recoveryMessage}`,
          );
          emitInteractionBoundary();
          const decision = await requestPermissionApproval({
            appId: agentInput.appId,
            agentId: agentInput.agentId,
            groupFolder: workspaceFolder,
            targetJid: agentInput.chatJid,
            toolName: publicToolName,
            title: permissionOpts.title,
            displayName:
              publicToolName === toolName
                ? permissionOpts.displayName
                : publicToolName,
            description: permissionOpts.description,
            decisionReason:
              permissionOpts.decisionReason ?? toolDecision.reason,
            closestRule: toolDecision.closestRule,
            blockedPath: permissionOpts.blockedPath,
            toolInput,
            toolUseID: permissionOpts.toolUseID,
            agentID: permissionOpts.agentID,
            suggestions: scheduledPermissionSuggestions(
              toolName,
              permissionOpts.suggestions,
              { blockedPath: permissionOpts.blockedPath, toolInput },
            ),
            threadId: agentInput.threadId,
          });
          if (decision.approved) {
            for (const rule of permissionUpdateAllowedToolRules(
              decision.updatedPermissions,
            )) {
              liveApprovedRules.add(rule);
            }
            rememberAllowedTool();
            log(
              `Autonomous job permission approved for tool ${toolName} by ${decision.decidedBy || 'unknown'}`,
            );
            return {
              behavior: 'allow' as const,
              updatedInput: applyBashTrustEnv(toolName, toolInput, sdkEnv),
              ...(decision.updatedPermissions
                ? { updatedPermissions: decision.updatedPermissions as never }
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
          log(`Autonomous job denied tool ${toolName}: ${message}`);
          return {
            behavior: 'deny' as const,
            message,
            interrupt: true,
            ...(decision.decisionClassification
              ? {
                  decisionClassification:
                    decision.decisionClassification as never,
                }
              : {}),
          };
        }
        if (capabilities.alwaysAllowedTools.includes(toolName)) {
          return allowToolUse();
        }
        const currentToolDecision = toolExecutionPolicy.evaluate({
          request: toolExecutionRequest,
          allowedToolRules: currentAllowedToolRules(),
        });
        if (currentToolDecision.status === 'allow') {
          log(
            `Permission allowed for tool ${toolName}: ${currentToolDecision.reason}`,
          );
          return allowToolUse();
        }
        if (permissionOpts.signal.aborted) {
          return {
            behavior: 'deny' as const,
            message: 'Permission request aborted',
          };
        }
        const publicToolName = permissionRequestToolName(toolName);
        emitInteractionBoundary();
        const decision = await requestPermissionApproval({
          appId: agentInput.appId,
          agentId: agentInput.agentId,
          groupFolder: workspaceFolder,
          toolName: publicToolName,
          title: permissionOpts.title,
          displayName:
            publicToolName === toolName
              ? permissionOpts.displayName
              : publicToolName,
          description: permissionOpts.description,
          decisionReason: permissionOpts.decisionReason,
          closestRule: currentToolDecision.closestRule,
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
          threadId: agentInput.threadId,
        });
        if (decision.approved) {
          for (const rule of permissionUpdateAllowedToolRules(
            decision.updatedPermissions,
          )) {
            liveApprovedRules.add(rule);
          }
          rememberAllowedTool();
          log(
            `Permission approved for tool ${toolName} by ${decision.decidedBy || 'unknown'}`,
          );
          return {
            behavior: 'allow' as const,
            updatedInput: applyBashTrustEnv(toolName, toolInput, sdkEnv),
            ...(decision.updatedPermissions
              ? { updatedPermissions: decision.updatedPermissions as never }
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
        log(`Permission denied for tool ${toolName}: ${reason}`);
        return {
          behavior: 'deny' as const,
          message: `Permission denied: ${reason}`,
          interrupt: false,
          ...(decision.decisionClassification
            ? {
                decisionClassification:
                  decision.decisionClassification as never,
              }
            : {}),
        };
      },
      settingSources: ['user'],
      mcpServers: capabilities.mcpServers,
      includePartialMessages: true,
    },
  });
  try {
    for await (const message of sdkQuery) {
      messageCount++;
      heartbeat.markActivity();
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);
      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        assertRequiredMcpServerReady(message);
        log('Session initialized: provider resume handle received');
      }
      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'compact_boundary'
      ) {
        log('SDK compact boundary observed');
        writeOutput({
          status: 'success',
          result: null,
          newSessionId,
          compactBoundary: true,
        });
      }
      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'task_notification'
      ) {
        const tn = message as {
          task_id: string;
          status: string;
          summary: string;
        };
        log(
          `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
        );
        writeOutput({
          status: 'success',
          result: null,
          runtimeEvents: [
            {
              appId: agentInput.appId,
              agentId: agentInput.agentId,
              runId: agentInput.runId,
              jobId: agentInput.jobId,
              conversationId: agentInput.chatJid,
              threadId: agentInput.threadId,
              actor: 'sdk',
              eventType: RUNTIME_EVENT_TYPES.TASK_NOTIFICATION,
              payload: {
                taskId: tn.task_id,
                status: tn.status,
                summary: tn.summary,
              },
            },
          ],
        });
      }
      if (message.type === 'stream_event') {
        const event = (message as { event?: unknown }).event as
          | {
              type?: string;
              delta?: { type?: string; text?: string };
            }
          | undefined;
        if (event?.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            sawPartialTextSinceLastResult = true;
            writeOutput({
              status: 'success',
              result: delta.text,
              newSessionId,
            });
          }
        }
      }
      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        log(
          `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        logUsage(message);
        const usage = normalizeModelUsage({
          message,
          fallbackModel: configuredModel,
        });
        const contextUsage = await readContextUsage(sdkQuery);
        const continuedByFollowup = steeringGate.pendingCount() > 0;
        writeOutput({
          status: 'success',
          result:
            textResult && !sawPartialTextSinceLastResult ? textResult : null,
          newSessionId,
          ...(primeToolAttempts.length > 0 ? { primeToolAttempts } : {}),
          ...(continuedByFollowup ? { continuedByFollowup: true } : {}),
          ...(contextUsage ? { contextUsage } : {}),
          ...(usage
            ? {
                usage,
                usageEventId: usageEventIdForMessage(
                  message,
                  newSessionId ?? agentInput.sessionId,
                  resultCount,
                  queryRunId,
                ),
              }
            : {}),
        });
        sawPartialTextSinceLastResult = false;
        steeringGate.markTurnBoundary();
      }
    }
  } finally {
    ipcPolling = false;
    heartbeat.stop();
    steeringGate.close();
  }
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
    primeToolAttempts,
  };
}
