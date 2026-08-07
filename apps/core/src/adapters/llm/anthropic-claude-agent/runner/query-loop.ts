import {
  query,
  type EffortLevel,
  type HookInput,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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
import { DelegatedCompletionGate } from '../../../../runner/delegated-completion-gate.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import {
  normalizeFilesystemSandboxPaths,
  readLocalCliCredentialDirectories,
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
  compileSdkResponseSchema,
  CompletionContinuationError,
  hasTopLevelAssistantContent,
  isSdkStructuredOutputValidationFailure,
  sdkResultFailureMessage,
  sdkResultText,
  sdkStructuredOutputRepairInstruction,
  StructuredOutputValidationError,
  sdkStructuredOutputOptions,
  shouldPrefixVisibleBoundary,
  topLevelAssistantText,
} from './sdk-message-output.js';
import {
  createCanUseToolCallback,
  createPermissionApprovalContextChannel,
} from './tool-permission-gate.js';
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
import {
  recordSuccessfulToolUse,
  toolResponseIsError,
} from './query-tool-success-ledger.js';
import { redactString } from '../../../../infrastructure/logging/logger.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import {
  auditExternalMcpResult,
  auditExternalMcpTerminal,
} from './external-mcp-audit-hook.js';
import {
  EXTERNAL_MCP_AUDIT_PREFIX,
  externalMcpAuditFilePath,
} from './external-mcp-audit-protocol.js';

export { recordSuccessfulToolUse } from './query-tool-success-ledger.js';

interface RunQueryOptions {
  enableIpcFollowups?: boolean;
  persistSdkSession?: boolean;
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
  completionGateAccepted: boolean;
  structuredResultValidated: boolean;
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
  const permissionApprovalContext = createPermissionApprovalContextChannel();
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
  const boundedScheduledFollowups =
    agentInput.isScheduledJob === true &&
    Boolean(agentInput.delegatedCompletionGate || agentInput.responseSchema);
  if (!enableIpcFollowups && !boundedScheduledFollowups) {
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
  let structuredRepairAttempts = 0;
  let structuredRepairPending = false;
  let completionGateAccepted = !agentInput.delegatedCompletionGate;
  let completionContinuationPending = false;
  let structuredResultValidated = !agentInput.responseSchema;
  const validateResponse = compileSdkResponseSchema(agentInput.responseSchema);
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
  // Two-axis model (decision 0040): `direct` = authorization is the whole control
  // (permission engine + classifier + host-side credential/protected-path rail);
  // no inner SDK Seatbelt, so Chromium's Mach-port register (and the whole class)
  // runs. `sandbox_runtime` confinement is the runner OS sandbox
  // (runner-sandbox-provider), which is applied out-of-band — this SDK-level
  // filesystem Seatbelt is never the confinement layer, so it is dropped.
  const sdkFilesystemSandbox = undefined;
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
    callableAgentManifest: agentInput.callableAgentManifest,
    runLeaseToken: agentInput.runLeaseToken,
    runLeaseFencingVersion: agentInput.runLeaseFencingVersion,
    liveStopActionToken: process.env.GANTRY_LIVE_STOP_ACTION_TOKEN,
    memoryUserId: agentInput.memoryUserId,
    memoryDefaultScope: agentInput.memoryDefaultScope,
    memoryReviewerIsControlApprover: agentInput.memoryReviewerIsControlApprover,
    persona: agentInput.persona,
    browserProfileName: agentInput.browserProfileName,
    browserTurnToken: agentInput.browserTurnToken,
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
    callerResolvedTools: agentInput.callerResolvedTools,
    callerResolvedDelegationEnabled:
      agentInput.toolAccessRequirements?.includes('AgentDelegation') === true,
  });
  const completionGate = agentInput.delegatedCompletionGate
    ? new DelegatedCompletionGate(agentInput.delegatedCompletionGate)
    : undefined;
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
  const externalMcpServerNames = Object.keys(capabilities.mcpServers ?? {});
  const pendingExternalMcpToolUses = new Map<
    string,
    { name: string; input: unknown }
  >();
  const auditedExternalMcpToolCallIds = new Set<string>();
  const externalMcpAuditFile = externalMcpAuditFilePath();
  let externalMcpAuditFileOffset = 0;
  let externalMcpAuditFileBuffer = Buffer.alloc(0);
  const emitExternalMcpAuditPayload = (payload: Record<string, unknown>) => {
    const toolCallId =
      typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
    if (toolCallId && auditedExternalMcpToolCallIds.has(toolCallId)) return;
    const serverName =
      typeof payload.serverName === 'string' ? payload.serverName : '';
    if (
      serverName === 'gantry' ||
      !externalMcpServerNames.includes(serverName)
    ) {
      throw new Error('unrecognized external MCP audit server');
    }
    writeOutput({
      status: 'success',
      result: null,
      runtimeEventOnly: true,
      runtimeEvents: [
        {
          appId: agentInput.appId,
          agentId: agentInput.agentId,
          runId: agentInput.runId,
          jobId: agentInput.jobId,
          conversationId: agentInput.chatJid,
          threadId: agentInput.threadId,
          eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
          actor: 'audited-external-mcp-proxy',
          responseMode: 'none',
          payload,
        },
      ],
    });
    if (toolCallId) auditedExternalMcpToolCallIds.add(toolCallId);
  };
  const drainExternalMcpAuditFile = () => {
    if (!externalMcpAuditFile || !fs.existsSync(externalMcpAuditFile)) return;
    const contents = fs.readFileSync(externalMcpAuditFile);
    if (contents.length < externalMcpAuditFileOffset) {
      externalMcpAuditFileOffset = 0;
      externalMcpAuditFileBuffer = Buffer.alloc(0);
    }
    if (contents.length > externalMcpAuditFileOffset) {
      externalMcpAuditFileBuffer = Buffer.concat([
        externalMcpAuditFileBuffer,
        contents.subarray(externalMcpAuditFileOffset),
      ]);
      externalMcpAuditFileOffset = contents.length;
    }
    let newlineIndex = externalMcpAuditFileBuffer.indexOf(0x0a);
    while (newlineIndex >= 0) {
      const line = externalMcpAuditFileBuffer
        .subarray(0, newlineIndex)
        .toString('utf8');
      externalMcpAuditFileBuffer = externalMcpAuditFileBuffer.subarray(
        newlineIndex + 1,
      );
      if (line.trim()) {
        try {
          emitExternalMcpAuditPayload(
            JSON.parse(line) as Record<string, unknown>,
          );
        } catch (error) {
          log(
            `Invalid external MCP audit file record: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      newlineIndex = externalMcpAuditFileBuffer.indexOf(0x0a);
    }
  };
  let stderrBuffer = '';
  const handleClaudeStderr = (data: string) => {
    stderrBuffer += data;
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const prefixIndex = line.indexOf(EXTERNAL_MCP_AUDIT_PREFIX);
      if (prefixIndex < 0) {
        log(`[claude-code stderr] ${line}`);
        continue;
      }
      try {
        const payload = JSON.parse(
          line.slice(prefixIndex + EXTERNAL_MCP_AUDIT_PREFIX.length),
        ) as Record<string, unknown>;
        emitExternalMcpAuditPayload(payload);
      } catch (error) {
        log(
          `[claude-code stderr] invalid external MCP audit: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const postToolUseHook = async (
    hookInput: HookInput,
    toolUseID: string | undefined,
    hookOptions: { signal: AbortSignal },
  ) => {
    if (hookInput.hook_event_name === 'PostToolUse' && toolSuccessLedger) {
      recordSuccessfulToolUse(hookInput, toolSuccessLedger);
    }
    const permissionResult = await permissionApprovalContext.postToolUse(
      hookInput,
      toolUseID,
      hookOptions,
    );
    const auditResult = auditExternalMcpTerminal({
      hookInput,
      toolUseId: toolUseID,
      serverNames: externalMcpServerNames,
      agentInput,
    });
    if (auditResult.auditedToolCallId) {
      auditedExternalMcpToolCallIds.add(auditResult.auditedToolCallId);
    }
    if (auditResult.updatedToolOutput === undefined) return permissionResult;
    const permissionHookOutput =
      'hookSpecificOutput' in permissionResult
        ? permissionResult.hookSpecificOutput
        : undefined;
    return {
      ...permissionResult,
      hookSpecificOutput: {
        ...(permissionHookOutput ?? {}),
        hookEventName: 'PostToolUse' as const,
        updatedToolOutput: auditResult.updatedToolOutput,
      },
    };
  };
  const canUseTool = createCanUseToolCallback({
    agentInput,
    sdkEnv: isolatedSdkEnv,
    workspaceFolder,
    memoryBlock,
    configuredModel,
    capabilities,
    primeToolAttempts,
    getNewSessionId: () => newSessionId,
    emitInteractionBoundary,
    recordToolActivity: (toolName) => heartbeat.recordToolActivity(toolName),
    recordPermissionApprovalContext: permissionApprovalContext.record,
  });
  const guardedCanUseTool: typeof canUseTool = async (...args) => {
    if (structuredRepairPending) {
      return {
        behavior: 'deny' as const,
        message:
          'Tools are disabled during the bounded response_schema repair turn.',
        interrupt: false,
      };
    }
    return canUseTool(...args);
  };
  const sdkQuery = query({
    prompt: stream,
    options: {
      model: configuredModel,
      ...sdkStructuredOutputOptions(agentInput.responseSchema),
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
      disallowedTools: [...capabilities.disallowedTools],
      env: isolatedSdkEnv,
      // Without this the subprocess's own stderr is lost and startup failures
      // surface only as "Claude Code process exited with code 1".
      stderr: handleClaudeStderr,
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
        PostToolUse: [
          {
            hooks: [postToolUseHook],
          },
        ],
        PostToolUseFailure: [
          {
            hooks: [postToolUseHook],
          },
        ],
      },
      canUseTool: guardedCanUseTool,
      // Load only the per-run CLAUDE_CONFIG_DIR settings so Claude discovers
      // Gantry-materialized skills without reading workspace configuration.
      settingSources: ['user'],
      mcpServers: capabilities.mcpServers,
      strictMcpConfig: true,
      includePartialMessages: true,
    },
  });
  const sdkQueryIteratorMs = elapsedMs();
  log(`SDK query iterator created in ${sdkQueryIteratorMs}ms`);
  const externalMcpAuditPump = externalMcpAuditFile
    ? setInterval(drainExternalMcpAuditFile, 250)
    : undefined;
  externalMcpAuditPump?.unref();
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
      drainExternalMcpAuditFile();
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      // api_retry/auth errors carry the reason in the payload; without it a
      // failing turn logs an undiagnosable retry loop.
      const errorDetail = (
        message as { error?: unknown; error_status?: unknown }
      ).error_status
        ? ` error_status=${String((message as { error_status?: unknown }).error_status)} error=${String((message as { error?: unknown }).error ?? '')}`
        : '';
      log(`[msg #${messageCount}] type=${msgType}${errorDetail}`);
      if (!firstSdkMessageLogged) {
        firstSdkMessageLogged = true;
        firstSdkEventMs = elapsedMs();
        log(`First SDK message after ${firstSdkEventMs}ms`);
      }
      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }
      if (message.type === 'assistant' || message.type === 'user') {
        const content = (
          message as {
            message?: { content?: unknown };
          }
        ).message?.content;
        if (Array.isArray(content)) {
          if (message.type === 'assistant') {
            for (const item of content) {
              if (!item || typeof item !== 'object') continue;
              const block = item as Record<string, unknown>;
              if (
                block.type === 'tool_use' &&
                typeof block.id === 'string' &&
                typeof block.name === 'string'
              ) {
                pendingExternalMcpToolUses.set(block.id, {
                  name: block.name,
                  input: block.input,
                });
              }
            }
          } else {
            for (const item of content) {
              if (!item || typeof item !== 'object') continue;
              const block = item as Record<string, unknown>;
              const toolCallId =
                block.type === 'tool_result' &&
                typeof block.tool_use_id === 'string'
                  ? block.tool_use_id
                  : null;
              if (!toolCallId) continue;
              const toolUse = pendingExternalMcpToolUses.get(toolCallId);
              if (!toolUse) continue;
              const toolResponse = { content: block.content };
              const provenanceToolCallId = externalMcpProvenanceToolCallId(
                block.content,
              );
              const auditedToolCallId = provenanceToolCallId ?? toolCallId;
              if (auditedExternalMcpToolCallIds.has(auditedToolCallId)) {
                pendingExternalMcpToolUses.delete(toolCallId);
                continue;
              }
              const auditResult = auditExternalMcpResult({
                toolName: toolUse.name,
                toolCallId: auditedToolCallId,
                toolInput: toolUse.input,
                toolResponse,
                failed:
                  block.is_error === true || toolResponseIsError(toolResponse),
                serverNames: externalMcpServerNames,
                agentInput,
              });
              if (auditResult.auditedToolCallId) {
                auditedExternalMcpToolCallIds.add(auditedToolCallId);
              }
              pendingExternalMcpToolUses.delete(toolCallId);
            }
          }
        }
      }
      if (message.type === 'assistant') {
        if (agentInput.responseSchema) continue;
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
        log(
          `MCP server statuses: ${message.mcp_servers
            .map((server) => `${server.name}=${server.status}`)
            .join(',')}`,
        );
        const detailedMcpStatuses =
          typeof sdkQuery.mcpServerStatus === 'function'
            ? await sdkQuery.mcpServerStatus()
            : [];
        const failedMcpServer = detailedMcpStatuses.find(
          (server) =>
            server.status === 'failed' ||
            server.status === 'needs-auth' ||
            server.status === 'disabled',
        );
        if (failedMcpServer?.error) {
          throw new Error(
            `Required MCP server "${failedMcpServer.name}" is not ready: ${failedMcpServer.status}: ${redactString(failedMcpServer.error)}`,
          );
        }
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
        if (agentInput.responseSchema) continue;
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
        const resultFailure = sdkResultFailureMessage(message);
        const structuredSdkFailure =
          resultFailure && isSdkStructuredOutputValidationFailure(message);
        if (resultFailure && !structuredSdkFailure) {
          throw completionContinuationPending
            ? new CompletionContinuationError(resultFailure)
            : new Error(resultFailure);
        }
        const completionDecision = await completionGate?.check();
        const continuedByCompletionGate =
          completionDecision?.decision === 'continue';
        completionGateAccepted = !completionGate || !continuedByCompletionGate;
        completionContinuationPending = continuedByCompletionGate;
        if (continuedByCompletionGate) structuredRepairPending = false;
        let continuedBySchemaRepair = false;
        let textResult: string | null = null;
        if (!continuedByCompletionGate) {
          try {
            textResult = sdkResultText(
              message,
              agentInput.responseSchema,
              validateResponse,
            );
            structuredResultValidated =
              !agentInput.responseSchema || textResult !== null;
            structuredRepairPending = false;
          } catch (error) {
            if (
              error instanceof StructuredOutputValidationError &&
              agentInput.responseSchema &&
              structuredRepairAttempts < 1
            ) {
              structuredRepairAttempts += 1;
              structuredRepairPending = true;
              structuredResultValidated = false;
              continuedBySchemaRepair = true;
              steeringGate.accept(
                sdkStructuredOutputRepairInstruction(error, message),
              );
            } else {
              throw error;
            }
          }
        }
        const emittedVisibleText =
          sawPartialTextSinceLastResult || sawStructuredTextSinceLastResult;
        const canUseResultFallback =
          !emittedVisibleText && !sawAssistantContentSinceLastResult;
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
        const contextUsagePromise = readContextUsage(sdkQuery);
        if (continuedByCompletionGate) {
          steeringGate.accept(completionDecision.message);
        }
        const continuedByFollowup = steeringGate.pendingCount() > 0;
        writeOutput({
          status: 'success',
          result: textResult && canUseResultFallback ? textResult : null,
          newSessionId,
          ...(primeToolAttempts.length > 0 ? { primeToolAttempts } : {}),
          ...(continuedByFollowup ? { continuedByFollowup: true } : {}),
          ...(!continuedByFollowup && completionGate
            ? { completionGateAccepted }
            : {}),
          ...(!continuedByFollowup && agentInput.responseSchema
            ? { structuredResultValidated }
            : {}),
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
        if (
          boundedScheduledFollowups &&
          !continuedByCompletionGate &&
          !continuedBySchemaRepair
        ) {
          stream.end();
        }
        const contextUsage = await contextUsagePromise;
        if (contextUsage) {
          writeOutput({
            status: 'success',
            result: null,
            newSessionId,
            runtimeEventOnly: true,
            contextUsage,
          });
        }
      }
    }
    drainExternalMcpAuditFile();
  } catch (error) {
    if (
      completionContinuationPending &&
      !(error instanceof CompletionContinuationError) &&
      !(error instanceof StructuredOutputValidationError)
    ) {
      throw new CompletionContinuationError(error);
    }
    throw error;
  } finally {
    if (externalMcpAuditPump) clearInterval(externalMcpAuditPump);
    drainExternalMcpAuditFile();
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
  if (boundedScheduledFollowups && completionGate && !completionGateAccepted) {
    throw new CompletionContinuationError(
      'Claude SDK ended before the configured completion gate accepted the run.',
    );
  }
  if (
    boundedScheduledFollowups &&
    agentInput.responseSchema &&
    !structuredResultValidated
  ) {
    throw new StructuredOutputValidationError(
      'Claude SDK ended without a validated response_schema result.',
    );
  }
  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return {
    newSessionId,
    lastAssistantUuid,
    closedDuringQuery,
    primeToolAttempts,
    completionGateAccepted,
    structuredResultValidated,
  };
}

function externalMcpProvenanceToolCallId(content: unknown): string | undefined {
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((item) => {
            if (!item || typeof item !== 'object') return [];
            const text = (item as { text?: unknown }).text;
            return typeof text === 'string' ? [text] : [];
          })
        : [];
  for (const text of texts) {
    try {
      const value = JSON.parse(text) as {
        gantryProvenance?: { toolCallId?: unknown };
      };
      if (typeof value.gantryProvenance?.toolCallId === 'string') {
        return value.gantryProvenance.toolCallId;
      }
    } catch {
      // Most MCP text results are not JSON provenance records.
    }
  }
  return undefined;
}
