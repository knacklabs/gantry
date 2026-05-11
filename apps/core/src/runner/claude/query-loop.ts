import {
  query,
  type SandboxSettings,
  type EffortLevel,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import type { AgentRunnerInput } from './types.js';
import {
  findModelByRunnerModel,
  normalizeModelUsage,
  type RuntimeContextUsageSnapshot,
} from '../../shared/model-catalog.js';
import { validateAgentToolInput } from './agent-model-selection.js';
import { usageEventIdForMessage } from './query-usage-event-id.js';
import { readLiveToolRules } from '../../shared/live-tool-rules.js';
import { permissionUpdateAllowedToolRules } from '../../shared/permission-tool-rules.js';
import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../shared/tool-execution-policy-service.js';
import { readExternalMcpServers } from './mcp-server-validation.js';
import { nowIso } from '../../shared/time/datetime.js';

const PROTECTED_FILESYSTEM_PATHS_ENV = 'MYCLAW_PROTECTED_FILESYSTEM_PATHS_JSON';

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
  const systemPrompt = buildRunnerSystemPrompt(agentInput, memoryBlock);
  const extraDirs = discoverAdditionalDirectories();
  const protectedFilesystemPaths = readProtectedFilesystemPaths();
  const currentModel = findModelByRunnerModel(configuredModel);
  const capabilities = composeAgentCapabilities({
    mcpServerPath,
    chatJid: agentInput.chatJid,
    groupFolder: agentInput.groupFolder,
    threadId: agentInput.threadId,
    memoryUserId: agentInput.memoryUserId,
    memoryDefaultScope: agentInput.memoryDefaultScope,
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

  function currentAllowedToolRules(): string[] {
    return [
      ...capabilities.allowedTools,
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
        if (toolName === 'Agent' || toolName === 'Task') {
          const modelDenial = validateAgentToolInput(input, currentModel);
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
          input,
          permissionOpts,
        );
        if (protectedCapabilityDenial) {
          log(
            `Permission denied by protected capability guard: ${protectedCapabilityDenial}`,
          );
          return {
            behavior: 'deny' as const,
            message: protectedCapabilityDenial,
            interrupt: false,
          };
        }

        const memoryGuardDenial = denyMemoryBoundaryToolUse(
          toolName,
          input,
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

        const toolExecutionRequest = toolExecutionClassifier.classify({
          origin: 'sdk',
          toolName,
          toolInput: input,
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
            schedulerAllowedToolRules: agentInput.allowedTools ?? [],
          });
          if (toolDecision.status === 'allow') {
            log(
              `Autonomous job allowed tool ${toolName}: ${toolDecision.reason}`,
            );
            return { behavior: 'allow' as const, updatedInput: input };
          }
          const message = `${toolDecision.reason} Recovery: ${toolDecision.recoveryAction}`;
          log(`Autonomous job denied tool ${toolName}: ${message}`);
          return {
            behavior: 'deny' as const,
            message,
            interrupt: true,
          };
        }

        if (capabilities.alwaysAllowedTools.includes(toolName)) {
          return { behavior: 'allow' as const, updatedInput: input };
        }

        const currentToolDecision = toolExecutionPolicy.evaluate({
          request: toolExecutionRequest,
          allowedToolRules: currentAllowedToolRules(),
        });
        if (currentToolDecision.status === 'allow') {
          log(
            `Permission allowed for tool ${toolName}: ${currentToolDecision.reason}`,
          );
          return { behavior: 'allow' as const, updatedInput: input };
        }

        if (permissionOpts.signal.aborted) {
          return {
            behavior: 'deny' as const,
            message: 'Permission request aborted',
          };
        }
        emitInteractionBoundary();
        const decision = await requestPermissionApproval({
          appId: agentInput.appId,
          agentId: agentInput.agentId,
          groupFolder: agentInput.groupFolder,
          toolName,
          title: permissionOpts.title,
          displayName: permissionOpts.displayName,
          description: permissionOpts.description,
          decisionReason: permissionOpts.decisionReason,
          blockedPath: permissionOpts.blockedPath,
          toolInput: input,
          toolUseID: permissionOpts.toolUseID,
          agentID: permissionOpts.agentID,
          suggestions:
            (permissionOpts.suggestions?.length ?? 0) > 0
              ? permissionOpts.suggestions
              : synthesizePermissionSuggestions(toolName, {
                  blockedPath: permissionOpts.blockedPath,
                }),
          threadId: agentInput.threadId,
        });
        if (decision.approved) {
          for (const rule of permissionUpdateAllowedToolRules(
            decision.updatedPermissions,
          )) {
            liveApprovedRules.add(rule);
          }
          log(
            `Permission approved for tool ${toolName} by ${decision.decidedBy || 'unknown'}`,
          );
          return {
            behavior: 'allow' as const,
            updatedInput: input,
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

  for await (const message of sdkQuery) {
    messageCount++;
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

  ipcPolling = false;
  steeringGate.close();
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
  };
}

function readProtectedFilesystemPaths(): string[] {
  const raw = process.env[PROTECTED_FILESYSTEM_PATHS_ENV]?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${PROTECTED_FILESYSTEM_PATHS_ENV} must be valid JSON.`);
  }
  if (!Array.isArray(parsed))
    throw new Error(`${PROTECTED_FILESYSTEM_PATHS_ENV} must be a JSON array.`);
  return normalizeProtectedPaths(parsed);
}

function buildSdkFilesystemSandbox(paths: readonly string[]): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    filesystem: { denyWrite: normalizeProtectedPaths(paths) },
  };
}

function normalizeProtectedPaths(values: readonly unknown[]): string[] {
  return [...new Set(values.flatMap(resolvePathForSandbox))].sort();
}

function resolvePathForSandbox(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  const absolute = path.resolve(value.trim());
  try {
    if (fs.existsSync(absolute)) return [fs.realpathSync.native(absolute)];
    const parent = path.dirname(absolute);
    if (fs.existsSync(parent))
      return [
        path.join(fs.realpathSync.native(parent), path.basename(absolute)),
      ];
  } catch {}
  return [absolute];
}

function synthesizePermissionSuggestions(
  toolName: string,
  options: { blockedPath?: string },
): unknown[] | undefined {
  const normalizedToolName = toolName.trim();
  if (!normalizedToolName) return undefined;
  const ruleContent = inferPermissionRuleContent(options);
  if (!ruleContent) return undefined;
  return [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'session',
      rules: [
        {
          toolName: normalizedToolName,
          ...(ruleContent ? { ruleContent } : {}),
        },
      ],
    },
  ];
}

function inferPermissionRuleContent(options: {
  blockedPath?: string;
}): string | undefined {
  const scope = trimmed(options.blockedPath);
  if (!scope) return undefined;
  return scope;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = value.trim();
  return out || undefined;
}

function assertRequiredMcpServerReady(message: unknown): void {
  const initMessage = message as {
    mcp_servers?: Array<{ name?: unknown; status?: unknown }>;
  };
  if (!Array.isArray(initMessage.mcp_servers)) {
    throw new Error(
      'Required MyClaw MCP server status is missing from Claude init',
    );
  }

  const myclawServer = initMessage.mcp_servers.find(
    (server) => server.name === 'myclaw',
  );
  if (!myclawServer) {
    throw new Error('Required MyClaw MCP server is missing from Claude init');
  }

  const status = String(myclawServer.status ?? '').toLowerCase();
  if (status !== 'connected') {
    throw new Error(`Required MyClaw MCP server is not ready: ${status}`);
  }
}

async function readContextUsage(queryHandle: unknown) {
  const candidate = queryHandle as {
    getContextUsage?: () => Promise<{
      totalTokens: number;
      maxTokens: number;
      percentage: number;
      model?: string;
      categories?: Array<{
        name: string;
        tokens: number;
        percentage?: number;
      }>;
      apiUsage?: RuntimeContextUsageSnapshot['apiUsage'];
    }>;
  };
  if (typeof candidate.getContextUsage !== 'function') return undefined;
  try {
    const usage = await candidate.getContextUsage();
    return {
      totalTokens: usage.totalTokens,
      maxTokens: usage.maxTokens,
      percentage: usage.percentage,
      model: usage.model,
      categories: (usage.categories ?? []).map((category) => ({
        name: category.name,
        tokens: category.tokens,
        percentage: category.percentage,
      })),
      apiUsage: usage.apiUsage,
      at: nowIso(),
    } satisfies RuntimeContextUsageSnapshot;
  } catch (err) {
    log(
      `Context usage unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

function readExternalMcpAllowedTools(): readonly string[] {
  const raw = process.env.MYCLAW_MCP_ALLOWED_TOOLS_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function readExternalMcpAlwaysAllowedTools(): readonly string[] {
  const raw = process.env.MYCLAW_MCP_ALWAYS_ALLOWED_TOOLS_JSON?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function logUsage(message: unknown): void {
  const resultMsg = message as {
    total_cost_usd?: number;
    num_turns?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    modelUsage?: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
      }
    >;
  };
  if (resultMsg.modelUsage) {
    for (const [model, usage] of Object.entries(resultMsg.modelUsage)) {
      const cacheRead = usage.cacheReadInputTokens || 0;
      const cacheWrite = usage.cacheCreationInputTokens || 0;
      const totalInput = usage.inputTokens || 0;
      const cacheHitPct =
        totalInput > 0 ? ((cacheRead / totalInput) * 100).toFixed(1) : '0.0';
      log(
        `Usage [${model}]: input=${totalInput} output=${usage.outputTokens || 0} ` +
          `cacheRead=${cacheRead} cacheWrite=${cacheWrite} ` +
          `cacheHit=${cacheHitPct}% cost=$${(usage.costUSD || 0).toFixed(4)}`,
      );
    }
  }
  if (resultMsg.total_cost_usd !== undefined) {
    log(
      `Total: cost=$${resultMsg.total_cost_usd.toFixed(4)} ` +
        `turns=${resultMsg.num_turns || 0} ` +
        `duration=${resultMsg.duration_ms || 0}ms ` +
        `apiTime=${resultMsg.duration_api_ms || 0}ms`,
    );
  }
}
