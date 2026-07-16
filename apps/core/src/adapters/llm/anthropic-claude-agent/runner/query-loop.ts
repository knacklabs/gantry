import {
  query,
  type EffortLevel,
  type HookInput,
  type PostToolUseHookInput,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { composeAgentCapabilities } from '../agent-capabilities.js';
import {
  SDK_NATIVE_SKILL_DISABLE_ENV,
  SDK_NATIVE_SKILL_OVERRIDES,
  readClaudeSdkSkillNamesFromEnv,
} from '../native-sdk-skills.js';
import { MessageStream } from './message-stream.js';
import {
  drainInteractionBoundaries,
  drainIpcInput,
  shouldClose,
} from './ipc-input.js';
import { SteeringDeliveryGate } from './steering-delivery-gate.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import {
  buildSdkFilesystemSandbox,
  normalizeFilesystemSandboxPaths,
  readLocalCliCredentialDirectories,
  readProtectedFilesystemSandboxPaths,
} from './filesystem-sandbox.js';
import { createSafetyPreToolUseHook } from './protected-capability-hook.js';
import {
  allowedOuterSandboxClaudeExecutable,
  discoverAdditionalDirectories,
  IPC_INPUT_DIR,
  IPC_INTERACTION_BOUNDARY_DIR,
  RUNTIME_SIGNAL_FALLBACK_POLL_MS,
  resolveClaudeCodeExecutableFromPath,
  WORKSPACE_GROUP_DIR,
} from './runtime-env.js';
import {
  buildRunnerSystemPrompt,
  readMemoryContextBlock,
} from './system-prompt.js';
import type {
  AgentRunnerInput,
  AgentRunnerToolAttemptOutput,
} from './types.js';
import { normalizeModelUsage } from '../../../../shared/model-usage.js';
import { nowMs as currentTimeMs } from '../../../../shared/time/datetime.js';
import { usageEventIdForMessage } from './query-usage-event-id.js';
import {
  assertRequiredMcpServerReady,
  readExternalMcpServers,
} from './mcp-server-validation.js';
import {
  readExternalMcpAllowedTools,
  readExternalMcpAlwaysAllowedTools,
} from './external-mcp-tool-rules.js';
import { startJobHeartbeat } from './job-heartbeat.js';
import { logUsage } from './usage-logging.js';
import { readContextUsage } from './context-usage.js';
import {
  hasTopLevelAssistantContent,
  sdkResultFailureMessage,
  shouldPrefixVisibleBoundary,
  topLevelAssistantText,
} from './sdk-message-output.js';
import { createCanUseToolCallback } from './tool-permission-gate.js';
import {
  decideClaudeSdkToolSearch,
  toolSearchStartupRuntimeEvent,
} from './tool-search-decision.js';
import { runnerStartupTimingRuntimeEvent } from './runner-startup-diagnostic.js';
import { startRuntimeSignalPump } from '../../../../runner/runtime-signal-pump.js';
import { taskRuntimeEvent } from './task-runtime-event.js';
import {
  evaluateDeclarativeToolRules,
  RunScopedToolSuccessLedger,
} from '../../../../runner/tool-gate-core.js';
import { canonicalGantryToolRuleName } from '../../../../shared/gantry-tool-facades.js';
import { emitJobToolActivity } from './tool-permission-events.js';

interface RunQueryOptions {
  enableIpcFollowups?: boolean;
  persistSdkSession?: boolean;
}

function toolResponseIsError(response: unknown): boolean {
  if (Array.isArray(response)) return response.some(toolResponseIsError);
  if (!response || typeof response !== 'object') return false;
  const value = response as {
    is_error?: unknown;
    isError?: unknown;
    status?: unknown;
    error?: unknown;
    content?: unknown;
  };
  return (
    value.is_error === true ||
    value.isError === true ||
    value.status === 'error' ||
    Boolean(value.error) ||
    toolResponseIsError(value.content)
  );
}

export function recordSuccessfulToolUse(
  hookInput: Pick<PostToolUseHookInput, 'tool_name' | 'tool_response'>,
  toolSuccessLedger: RunScopedToolSuccessLedger,
): void {
  if (toolResponseIsError(hookInput.tool_response)) return;
  toolSuccessLedger.recordSuccess(
    canonicalGantryToolRuleName(hookInput.tool_name),
  );
}

function localCliCredentialDirectoriesFromRuntimeAccess(
  agentInput: AgentRunnerInput,
): string[] {
  const dirs = (agentInput.runtimeAccess ?? []).flatMap((access) =>
    access.sourceType === 'local_cli' ? access.credentialDirs : [],
  );
  return normalizeFilesystemSandboxPaths(dirs);
}

export async function runQuery(
  prompt: string,
  mcpServerPath: string,
  agentInput: AgentRunnerInput,
  sdkEnv: Record<string, string | undefined>,
  configuredModel: string | undefined,
  queryThinking: ThinkingConfig | undefined,
  queryEffort: EffortLevel | undefined,
  options: RunQueryOptions = {},
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  primeToolAttempts: AgentRunnerToolAttemptOutput[];
}> {
  const enableIpcFollowups = options.enableIpcFollowups ?? true;
  const persistSdkSession = options.persistSdkSession ?? true;
  const queryStartMs = currentTimeMs();
  const elapsedMs = () => Math.max(0, currentTimeMs() - queryStartMs);
  const stream = new MessageStream();
  const queryRunId = randomUUID();
  const memoryBlock = readMemoryContextBlock(agentInput);
  const toolSuccessLedger = agentInput.toolRules?.length
    ? new RunScopedToolSuccessLedger()
    : undefined;
  const declarativePreToolUse = toolSuccessLedger
    ? async (hookInput: {
        hook_event_name: string;
        tool_name?: string;
        tool_input?: unknown;
      }) => {
        if (
          hookInput.hook_event_name !== 'PreToolUse' ||
          !hookInput.tool_name
        ) {
          return { continue: true as const };
        }
        const denial = evaluateDeclarativeToolRules({
          toolName: canonicalGantryToolRuleName(hookInput.tool_name),
          toolInput: hookInput.tool_input,
          rules: agentInput.toolRules,
          successLedger: toolSuccessLedger,
        });
        if (!denial) return { continue: true as const };
        emitJobToolActivity(
          agentInput,
          () => newSessionId,
          'deny',
          hookInput.tool_name,
          {
            ok: false,
            reason: denial.error.message,
            decision: denial.decision,
            error: denial.error,
          },
        );
        return {
          continue: false as const,
          decision: 'block' as const,
          reason: JSON.stringify(denial.error),
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: denial.error.message,
          },
        };
      }
    : undefined;
  stream.pushInitialPrompt(prompt, memoryBlock);
  if (!enableIpcFollowups) {
    stream.end();
  }
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
  const processRuntimeSignalsDuringQuery = (): boolean => {
    if (!ipcPolling) return false;
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
      return false;
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
    return true;
  };
  const runtimeSignalPump = startRuntimeSignalPump({
    inputDir: IPC_INPUT_DIR,
    interactionBoundaryDir: IPC_INTERACTION_BOUNDARY_DIR,
    fallbackPollMs: RUNTIME_SIGNAL_FALLBACK_POLL_MS,
    processSignals: processRuntimeSignalsDuringQuery,
    deps: {
      onWatchError: ({ dir, error }) => {
        log(
          `Runtime signal watch failed for ${dir}: ${error instanceof Error ? error.message : String(error)}; using fallback poll`,
        );
      },
    },
  });
  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let sawPartialTextSinceLastResult = false;
  let sawAssistantContentSinceLastResult = false;
  let sawStructuredTextSinceLastResult = false;
  let visibleTextSinceLastResult = '';
  let pendingStructuredToPartialBoundary = false;
  const primeToolAttempts: AgentRunnerToolAttemptOutput[] = [];
  const heartbeat = startJobHeartbeat({
    agentInput,
    writeOutput,
    getSessionId: () => newSessionId,
  });
  const systemPrompt = buildRunnerSystemPrompt(agentInput, memoryBlock);
  const localCliCredentialDirectories = [
    ...new Set([
      ...readLocalCliCredentialDirectories(),
      ...localCliCredentialDirectoriesFromRuntimeAccess(agentInput),
    ]),
  ].sort();
  const extraDirs = discoverAdditionalDirectories();
  const additionalDirectories = [
    ...new Set([...extraDirs, ...localCliCredentialDirectories]),
  ].sort();
  const protectedFilesystemPaths = readProtectedFilesystemSandboxPaths();
  const protectedFilesystemDenyReadPaths = protectedFilesystemPaths.denyRead;
  const protectedFilesystemDenyWritePaths = [
    ...protectedFilesystemPaths.denyWrite,
    ...localCliCredentialDirectories,
  ];
  const sdkFilesystemSandbox =
    process.env.GANTRY_SANDBOX_RUNTIME_PROXY === '1'
      ? undefined
      : buildSdkFilesystemSandbox(protectedFilesystemDenyWritePaths, {
          denyReadPaths: protectedFilesystemDenyReadPaths,
          denyWritePaths: protectedFilesystemDenyWritePaths,
        });
  const workspaceFolder = agentInput.workspaceFolder;
  const enabledSdkSkills = readClaudeSdkSkillNamesFromEnv();
  const isolatedSdkEnv: Record<string, string | undefined> = {
    ...sdkEnv,
    ...SDK_NATIVE_SKILL_DISABLE_ENV,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  };
  const claudeCodeExecutable =
    process.env.GANTRY_SANDBOX_RUNTIME_PROXY === '1'
      ? allowedOuterSandboxClaudeExecutable(
          resolveClaudeCodeExecutableFromPath(isolatedSdkEnv.PATH),
        )
      : undefined;
  const capabilities = composeAgentCapabilities({
    mcpServerPath,
    appId: agentInput.appId,
    agentId: agentInput.agentId,
    chatJid: agentInput.chatJid,
    workspaceFolder: workspaceFolder,
    threadId: agentInput.threadId,
    jobId: agentInput.jobId,
    runHandle: process.env.GANTRY_AGENT_RUN_HANDLE,
    runId: agentInput.runId,
    parentTaskId: agentInput.parentTaskId,
    runLeaseToken: agentInput.runLeaseToken,
    runLeaseFencingVersion: agentInput.runLeaseFencingVersion,
    liveStopActionToken: process.env.GANTRY_LIVE_STOP_ACTION_TOKEN,
    memoryUserId: agentInput.memoryUserId,
    memoryDefaultScope: agentInput.memoryDefaultScope,
    memoryReviewerIsControlApprover: agentInput.memoryReviewerIsControlApprover,
    persona: agentInput.persona,
    browserProfileName: agentInput.browserProfileName,
    configuredAllowedTools: agentInput.allowedTools,
    attachedSkillSourceIds: agentInput.attachedSkillSourceIds,
    selectedSkillDisplays: agentInput.selectedSkillDisplays,
    attachedMcpSourceIds: agentInput.attachedMcpSourceIds,
    semanticCapabilities: agentInput.semanticCapabilities,
    hideAuthorityTools: agentInput.hideAuthorityTools === true,
    asyncTaskToolsEnabled: process.env.GANTRY_ASYNC_TASK_TOOLS_ENABLED === '1',
    memoryBlock,
    accessPreset:
      process.env.GANTRY_AGENT_ACCESS_PRESET === 'locked' ? 'locked' : 'full',
    ipcDir: process.env.GANTRY_IPC_DIR,
    ipcAuthToken: process.env.GANTRY_IPC_AUTH_TOKEN,
    browserIpcAuthToken: process.env.GANTRY_BROWSER_IPC_AUTH_TOKEN,
    memoryIpcAuthToken: process.env.GANTRY_MEMORY_IPC_AUTH_TOKEN,
    ipcResponseVerifyKey: process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY,
    ipcResponseKeyId: process.env.GANTRY_IPC_RESPONSE_KEY_ID,
    externalMcpServers: readExternalMcpServers(),
    externalMcpAllowedTools: readExternalMcpAllowedTools(),
    externalMcpAlwaysAllowedTools: readExternalMcpAlwaysAllowedTools(),
    isScheduledJob: agentInput.isScheduledJob,
  });
  const sdkQueryPreparedMs = elapsedMs();
  log(
    `SDK query prepared in ${sdkQueryPreparedMs}ms ` +
      `(tools=${capabilities.availableTools.length} mcpServers=${Object.keys(capabilities.mcpServers ?? {}).length})`,
  );
  const toolSearchDecision = decideClaudeSdkToolSearch({
    sdkEnv: isolatedSdkEnv,
    availableTools: capabilities.availableTools,
    allowedTools: capabilities.allowedTools,
    disallowedTools: capabilities.disallowedTools,
    mcpServers: capabilities.mcpServers,
  });
  isolatedSdkEnv.ENABLE_TOOL_SEARCH = toolSearchDecision.enableToolSearch;
  log(
    `SDK ToolSearch ${toolSearchDecision.enableToolSearch} ` +
      `(reason=${toolSearchDecision.reason} tools=${toolSearchDecision.availableToolCount} ` +
      `mcpServers=${toolSearchDecision.mcpServerCount} bytes=${toolSearchDecision.serializedToolConfigBytes})`,
  );
  const sdkQuery = query({
    prompt: stream,
    options: {
      model: configuredModel,
      thinking: queryThinking,
      effort: queryEffort,
      cwd: WORKSPACE_GROUP_DIR,
      additionalDirectories:
        additionalDirectories.length > 0 ? additionalDirectories : undefined,
      persistSession: persistSdkSession,
      ...(persistSdkSession && agentInput.sessionId
        ? { resume: agentInput.sessionId }
        : {}),
      systemPrompt,
      settings: {
        autoMemoryEnabled: false,
        includeGitInstructions: false,
        skillOverrides: SDK_NATIVE_SKILL_OVERRIDES,
      },
      skills: enabledSdkSkills,
      tools: [...capabilities.availableTools],
      allowedTools: [...capabilities.allowedTools],
      disallowedTools: [...capabilities.disallowedTools],
      env: isolatedSdkEnv,
      ...(claudeCodeExecutable
        ? { pathToClaudeCodeExecutable: claudeCodeExecutable }
        : {}),
      ...(sdkFilesystemSandbox ? { sandbox: sdkFilesystemSandbox } : {}),
      // Locked agents map to the SDK 'dontAsk' mode (deny if not pre-approved);
      // the canUseTool gate auto-denies the prompt with "capability not
      // provisioned" before any approval is requested.
      permissionMode:
        capabilities.permissionMode === 'deny'
          ? 'dontAsk'
          : capabilities.permissionMode,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              createSafetyPreToolUseHook(
                memoryBlock,
                agentInput.toolNetworkEnv ?? {},
              ),
              ...(declarativePreToolUse ? [declarativePreToolUse] : []),
            ],
            timeout: 5,
          },
        ],
        ...(toolSuccessLedger
          ? {
              PostToolUse: [
                {
                  hooks: [
                    async (hookInput: HookInput) => {
                      if (hookInput.hook_event_name === 'PostToolUse') {
                        recordSuccessfulToolUse(hookInput, toolSuccessLedger);
                      }
                      return { continue: true as const };
                    },
                  ],
                },
              ],
            }
          : {}),
      },
      canUseTool: createCanUseToolCallback({
        agentInput,
        sdkEnv: isolatedSdkEnv,
        workspaceFolder,
        memoryBlock,
        configuredModel,
        capabilities,
        primeToolAttempts,
        getNewSessionId: () => newSessionId,
        emitInteractionBoundary,
        recordToolActivity: (toolName) =>
          heartbeat.recordToolActivity(toolName),
      }),
      settingSources: [],
      mcpServers: capabilities.mcpServers,
      strictMcpConfig: true,
      includePartialMessages: true,
    },
  });
  const sdkQueryIteratorMs = elapsedMs();
  log(`SDK query iterator created in ${sdkQueryIteratorMs}ms`);
  try {
    let firstSdkMessageLogged = false;
    let firstTextDeltaLogged = false;
    let firstSdkEventMs: number | undefined;
    let providerSessionMs: number | undefined;
    let firstVisibleOutputMs: number | undefined;
    let firstResultMs: number | undefined;
    let startupTimingDiagnosticEmitted = false;
    const emitStartupTimingDiagnostic = () => {
      if (startupTimingDiagnosticEmitted) return;
      startupTimingDiagnosticEmitted = true;
      writeOutput({
        status: 'success',
        result: null,
        newSessionId,
        runtimeEventOnly: true,
        runtimeEvents: [
          runnerStartupTimingRuntimeEvent({
            agentInput,
            persistSdkSession,
            resumedSession: persistSdkSession && Boolean(agentInput.sessionId),
            sdkQueryPreparedMs,
            sdkQueryIteratorMs,
            firstSdkEventMs,
            providerSessionMs,
            firstVisibleOutputMs,
            firstResultMs,
            messageCount,
            resultCount,
            availableToolCount: capabilities.availableTools.length,
            allowedToolCount: capabilities.allowedTools.length,
            disallowedToolCount: capabilities.disallowedTools.length,
            mcpServerCount: Object.keys(capabilities.mcpServers ?? {}).length,
          }),
        ],
      });
    };
    for await (const message of sdkQuery) {
      messageCount++;
      heartbeat.markActivity();
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);
      if (!firstSdkMessageLogged) {
        firstSdkMessageLogged = true;
        firstSdkEventMs = elapsedMs();
        log(`First SDK message after ${firstSdkEventMs}ms`);
      }
      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }
      if (message.type === 'assistant') {
        if (hasTopLevelAssistantContent(message)) {
          sawAssistantContentSinceLastResult = true;
        }
        const assistantText = topLevelAssistantText(message);
        if (assistantText && !sawPartialTextSinceLastResult) {
          if (!firstTextDeltaLogged) {
            firstTextDeltaLogged = true;
            firstVisibleOutputMs = elapsedMs();
            log(`First SDK assistant text after ${firstVisibleOutputMs}ms`);
          }
          const visibleText = shouldPrefixVisibleBoundary(
            visibleTextSinceLastResult,
            assistantText,
          )
            ? `\n\n${assistantText}`
            : assistantText;
          sawStructuredTextSinceLastResult = true;
          pendingStructuredToPartialBoundary = true;
          visibleTextSinceLastResult += visibleText;
          writeOutput({
            status: 'success',
            result: visibleText,
            newSessionId,
          });
          emitStartupTimingDiagnostic();
        }
      }
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        assertRequiredMcpServerReady(message);
        providerSessionMs = elapsedMs();
        log(
          `Session initialized after ${providerSessionMs}ms: provider resume handle received`,
        );
        writeOutput({
          status: 'success',
          result: null,
          newSessionId,
          runtimeEventOnly: true,
          runtimeEvents: [
            toolSearchStartupRuntimeEvent({
              agentInput,
              decision: toolSearchDecision,
            }),
          ],
        });
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
      const taskEvent =
        message.type === 'system'
          ? taskRuntimeEvent(agentInput, message as Record<string, unknown>)
          : null;
      if (taskEvent) {
        const payload = taskEvent.payload as Record<string, unknown>;
        log(`Task event: type=${taskEvent.eventType} task=${payload.taskId}`);
        writeOutput({
          status: 'success',
          result: null,
          runtimeEventOnly: true,
          runtimeEvents: [taskEvent],
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
            if (!firstTextDeltaLogged) {
              firstTextDeltaLogged = true;
              firstVisibleOutputMs = elapsedMs();
              log(`First SDK text delta after ${firstVisibleOutputMs}ms`);
            }
            const visibleText =
              pendingStructuredToPartialBoundary &&
              shouldPrefixVisibleBoundary(
                visibleTextSinceLastResult,
                delta.text,
              )
                ? `\n\n${delta.text}`
                : delta.text;
            pendingStructuredToPartialBoundary = false;
            sawPartialTextSinceLastResult = true;
            visibleTextSinceLastResult += visibleText;
            writeOutput({
              status: 'success',
              result: visibleText,
              newSessionId,
            });
            if (firstVisibleOutputMs !== undefined)
              emitStartupTimingDiagnostic();
          }
        }
      }
      if (message.type === 'result') {
        resultCount++;
        if (resultCount === 1) {
          firstResultMs = elapsedMs();
          log(`First SDK result after ${firstResultMs}ms`);
        }
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        const emittedVisibleText =
          sawPartialTextSinceLastResult || sawStructuredTextSinceLastResult;
        const canUseResultFallback =
          !emittedVisibleText && !sawAssistantContentSinceLastResult;
        const resultFailure = sdkResultFailureMessage(message);
        if (resultFailure) {
          throw new Error(resultFailure);
        }
        if (canUseResultFallback && textResult) {
          firstVisibleOutputMs ??= firstResultMs;
        }
        const loggedResultText = canUseResultFallback ? textResult : null;
        log(
          `Result #${resultCount}: subtype=${message.subtype}${loggedResultText ? ` text=${loggedResultText.slice(0, 200)}` : ''}`,
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
          result: textResult && canUseResultFallback ? textResult : null,
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
        emitStartupTimingDiagnostic();
        sawPartialTextSinceLastResult = false;
        sawAssistantContentSinceLastResult = false;
        sawStructuredTextSinceLastResult = false;
        visibleTextSinceLastResult = '';
        pendingStructuredToPartialBoundary = false;
        steeringGate.markTurnBoundary();
      }
    }
  } finally {
    ipcPolling = false;
    runtimeSignalPump.stop();
    heartbeat.stop();
    steeringGate.close();
  }
  if (messageCount === 0 && resultCount === 0 && !closedDuringQuery)
    throw new Error(
      persistSdkSession && agentInput.sessionId
        ? `No conversation found with session ID: ${agentInput.sessionId}`
        : 'Anthropic SDK query completed without messages or results',
    );
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
