// prettier-ignore
import { query, type EffortLevel, type Query, type SDKMessage, type ThinkingConfig } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { composeAgentCapabilities } from '../agent-capabilities.js';
// prettier-ignore
import { SDK_NATIVE_SKILL_DISABLE_ENV, SDK_NATIVE_SKILL_OVERRIDES, readClaudeSdkSkillNamesFromEnv } from '../native-sdk-skills.js';
import { normalizeModelUsage } from '../../../../shared/model-usage.js';
import { nowMs as currentTimeMs } from '../../../../shared/time/datetime.js';
// prettier-ignore
import { startRuntimeSignalPump, type RuntimeSignalPump } from '../../../../runner/runtime-signal-pump.js';
// prettier-ignore
import { evaluateDeclarativeToolRules, RunScopedToolSuccessLedger } from '../../../../runner/tool-gate-core.js';
// prettier-ignore
import { canonicalGantryToolRuleName, gantryOwnedToolActivityFamily } from '../../../../shared/gantry-tool-facades.js';
import type { ToolActivityFamily } from '../../../../domain/events/tool-activity.js';
import { MessageStream } from './message-stream.js';
// prettier-ignore
import { drainInteractionBoundaries, drainIpcInput, shouldClose } from './ipc-input.js';
import { SteeringDeliveryGate } from './steering-delivery-gate.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
// prettier-ignore
import { normalizeFilesystemSandboxPaths, readLocalCliCredentialDirectories } from './filesystem-sandbox.js';
import { createSafetyPreToolUseHook } from './protected-capability-hook.js';
// prettier-ignore
import { allowedOuterSandboxClaudeExecutable, discoverAdditionalDirectories, IPC_INPUT_DIR, IPC_INTERACTION_BOUNDARY_DIR, RUNTIME_SIGNAL_FALLBACK_POLL_MS, resolveClaudeCodeExecutableFromPath, WORKSPACE_GROUP_DIR } from './runtime-env.js';
// prettier-ignore
import { buildRunnerSystemPrompt, readMemoryContextBlock } from './system-prompt.js';
import type { AgentRunnerInput, AgentRunnerToolAttemptOutput } from './types.js';
import { usageEventIdForMessage } from './query-usage-event-id.js';
// prettier-ignore
import { assertRequiredMcpServerReady, readExternalMcpServers } from './mcp-server-validation.js';
// prettier-ignore
import { readExternalMcpAllowedTools, readExternalMcpAlwaysAllowedTools } from './external-mcp-tool-rules.js';
import { startJobHeartbeat } from './job-heartbeat.js';
import { logUsage } from './usage-logging.js';
import { readContextUsage } from './context-usage.js';
// prettier-ignore
import { hasTopLevelAssistantContent, sdkResultFailureMessage, shouldPrefixVisibleBoundary, topLevelAssistantText } from './sdk-message-output.js';
// prettier-ignore
import { createCanUseToolCallback, createPermissionApprovalContextChannel } from './tool-permission-gate.js';
// prettier-ignore
import { decideClaudeSdkToolSearch, toolSearchStartupRuntimeEvent, type ClaudeSdkToolSearchDecision } from './tool-search-decision.js';
import { runnerStartupTimingRuntimeEvent } from './runner-startup-diagnostic.js';
import { taskRuntimeEvent } from './task-runtime-event.js';
// prettier-ignore
import { emitTerminalToolActivity, emitToolActivity } from './tool-permission-events.js';
import { createPostToolUseHook } from './query-tool-activity-hook.js';

type AssistantMessage = Extract<SDKMessage, { type: 'assistant' }>;
type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
type StreamEventMessage = Extract<SDKMessage, { type: 'stream_event' }>;
type SystemMessage = Extract<SDKMessage, { type: 'system' }>;
type QueryLoopInput = Pick<QueryLoopContext, 'prompt' | 'mcpServerPath' | 'agentInput' | 'sdkEnv' | 'configuredModel' | 'queryThinking' | 'queryEffort' | 'enableIpcFollowups' | 'persistSdkSession'>;

export interface QueryLoopContext {
  prompt: string; mcpServerPath: string; agentInput: AgentRunnerInput;
  sdkEnv: Record<string, string | undefined>;
  configuredModel: string | undefined; queryThinking: ThinkingConfig | undefined;
  queryEffort: EffortLevel | undefined; enableIpcFollowups: boolean;
  persistSdkSession: boolean; elapsedMs: () => number; stream: MessageStream;
  queryRunId: string; newSessionId: string | undefined; toolActivitySequence: number;
  terminalToolInvocationIds: Set<string>;
  registeredGantryToolFamilies: Map<string, ToolActivityFamily>;
  gantryToolFamiliesByInvocation: Map<string, ToolActivityFamily>;
  memoryBlock: string; toolSuccessLedger: RunScopedToolSuccessLedger | undefined;
  permissionApprovalContext: ReturnType<typeof createPermissionApprovalContextChannel>;
  scheduledOneShot: boolean | undefined; ipcPolling: boolean; closedDuringQuery: boolean;
  steeringGate: SteeringDeliveryGate; runtimeSignalPump: RuntimeSignalPump;
  lastAssistantUuid: string | undefined; messageCount: number; resultCount: number;
  sawPartialTextSinceLastResult: boolean; sawAssistantContentSinceLastResult: boolean;
  sawStructuredTextSinceLastResult: boolean; visibleTextSinceLastResult: string;
  pendingStructuredToPartialBoundary: boolean; nudgedScheduledRunToFinish: boolean;
  primeToolAttempts: AgentRunnerToolAttemptOutput[];
  heartbeat: ReturnType<typeof startJobHeartbeat>;
  capabilities?: ReturnType<typeof composeAgentCapabilities>; sdkQuery?: Query;
  sdkQueryPreparedMs?: number; sdkQueryIteratorMs?: number;
  toolSearchDecision?: ClaudeSdkToolSearchDecision;
  firstSdkMessageLogged: boolean; firstTextDeltaLogged: boolean;
  firstSdkEventMs: number | undefined; providerSessionMs: number | undefined;
  firstVisibleOutputMs: number | undefined; firstResultMs: number | undefined;
  startupTimingDiagnosticEmitted: boolean;
}

function localCliCredentialDirectoriesFromRuntimeAccess(
  agentInput: AgentRunnerInput,
): string[] {
  const dirs = (agentInput.runtimeAccess ?? []).flatMap((access) =>
    access.sourceType === 'local_cli' ? access.credentialDirs : [],
  );
  return normalizeFilesystemSandboxPaths(dirs);
}

function emitTerminalToolOutcome(
  context: QueryLoopContext,
  input: {
    invocationId: string;
    toolName: string;
    family?: ToolActivityFamily;
    outcome: 'success' | 'failure';
    detail?: string;
  },
): void {
  if (context.terminalToolInvocationIds.has(input.invocationId)) return;
  context.terminalToolInvocationIds.add(input.invocationId);
  emitTerminalToolActivity({ agentInput: context.agentInput, getNewSessionId: () => context.newSessionId, ...input, seq: ++context.toolActivitySequence });
}

function emitInteractionBoundary(context: QueryLoopContext): void {
  // prettier-ignore
  writeOutput({ status: 'success', result: null, newSessionId: context.newSessionId, interactionBoundary: 'user_interaction' });
}

function processRuntimeSignalsDuringQuery(
  context: QueryLoopContext,
): boolean {
  if (!context.ipcPolling) return false;
  const interactionBoundaries = drainInteractionBoundaries();
  for (let i = 0; i < interactionBoundaries; i += 1) {
    emitInteractionBoundary(context);
  }
  if (shouldClose()) {
    log('Close sentinel detected during query, ending stream');
    context.closedDuringQuery = true;
    context.steeringGate.close();
    context.stream.end();
    context.ipcPolling = false;
    return false;
  }
  if (context.enableIpcFollowups) {
    const messages = drainIpcInput();
    for (const text of messages) {
      const delivery = context.steeringGate.accept(text);
      if (delivery === 'buffered') {
        log(
          `Buffering IPC message until query turn boundary (${text.length} chars)`,
        );
      }
    }
  }
  return true;
}

export function createQueryLoopContext(input: QueryLoopInput): QueryLoopContext {
  const { agentInput, enableIpcFollowups } = input;
  const queryStartMs = currentTimeMs();
  const elapsedMs = () => Math.max(0, currentTimeMs() - queryStartMs);
  const stream = new MessageStream();
  const memoryBlock = readMemoryContextBlock(agentInput);
  const toolSuccessLedger = agentInput.toolRules?.length
    ? new RunScopedToolSuccessLedger()
    : undefined;
  const permissionApprovalContext = createPermissionApprovalContextChannel();
  const scheduledOneShot = agentInput.isScheduledJob && !enableIpcFollowups;
  stream.pushInitialPrompt(input.prompt, memoryBlock);
  if (!enableIpcFollowups && !agentInput.isScheduledJob) stream.end();
  const steeringGate = new SteeringDeliveryGate((text) => {
    log(`Piping IPC message at turn boundary (${text.length} chars)`);
    stream.pushContent(text);
  });
  const contextRef: { current?: QueryLoopContext } = {};
  // prettier-ignore
  const runtimeSignalPump = startRuntimeSignalPump({
    inputDir: IPC_INPUT_DIR, interactionBoundaryDir: IPC_INTERACTION_BOUNDARY_DIR, fallbackPollMs: RUNTIME_SIGNAL_FALLBACK_POLL_MS,
    processSignals: () => processRuntimeSignalsDuringQuery(contextRef.current!),
    deps: {
      onWatchError: ({ dir, error }) => {
        log(`Runtime signal watch failed for ${dir}: ${error instanceof Error ? error.message : String(error)}; using fallback poll`);
      },
    },
  });
  const heartbeat = startJobHeartbeat({ agentInput, writeOutput, getSessionId: () => contextRef.current?.newSessionId });
  const context: QueryLoopContext = {
    ...input,
    elapsedMs, stream, queryRunId: randomUUID(), newSessionId: undefined,
    toolActivitySequence: 0,
    terminalToolInvocationIds: new Set<string>(),
    registeredGantryToolFamilies: new Map<string, ToolActivityFamily>(),
    gantryToolFamiliesByInvocation: new Map<string, ToolActivityFamily>(),
    memoryBlock, toolSuccessLedger, permissionApprovalContext, scheduledOneShot,
    ipcPolling: true, closedDuringQuery: false, steeringGate, runtimeSignalPump,
    lastAssistantUuid: undefined, messageCount: 0, resultCount: 0,
    sawPartialTextSinceLastResult: false, sawAssistantContentSinceLastResult: false,
    sawStructuredTextSinceLastResult: false, visibleTextSinceLastResult: '',
    pendingStructuredToPartialBoundary: false, nudgedScheduledRunToFinish: false,
    primeToolAttempts: [], heartbeat,
    firstSdkMessageLogged: false, firstTextDeltaLogged: false,
    firstSdkEventMs: undefined, providerSessionMs: undefined,
    firstVisibleOutputMs: undefined, firstResultMs: undefined,
    startupTimingDiagnosticEmitted: false,
  };
  contextRef.current = context;
  return context;
}

function createDeclarativePreToolUse(context: QueryLoopContext) {
  if (!context.toolSuccessLedger) return undefined;
  return async (hookInput: { hook_event_name: string; tool_name?: string; tool_input?: unknown; tool_use_id?: string }) => {
    if (
      hookInput.hook_event_name !== 'PreToolUse' ||
      !hookInput.tool_name
    ) {
      return { continue: true as const };
    }
    // prettier-ignore
    const denial = evaluateDeclarativeToolRules({ toolName: canonicalGantryToolRuleName(hookInput.tool_name), toolInput: hookInput.tool_input, rules: context.agentInput.toolRules, successLedger: context.toolSuccessLedger! });
    if (!denial) return { continue: true as const };
    const invocationId = hookInput.tool_use_id ?? randomUUID();
    emitToolActivity(
      context.agentInput,
      () => context.newSessionId,
      'deny',
      hookInput.tool_name,
      {
        ok: false,
        reason: denial.error.message,
        decision: denial.decision,
        error: denial.error,
        invocationId,
      },
    );
    emitTerminalToolOutcome(context, { invocationId, toolName: hookInput.tool_name, outcome: 'failure' });
    return {
      continue: false as const,
      decision: 'block' as const,
      reason: JSON.stringify(denial.error),
      hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: denial.error.message },
    };
  };
}

async function bindGantryToolRegistrationProvenance(
  context: QueryLoopContext,
  hookInput: { hook_event_name: string; tool_name?: string; tool_use_id?: string },
) {
  if (
    hookInput.hook_event_name === 'PreToolUse' &&
    hookInput.tool_name &&
    hookInput.tool_use_id
  ) {
    const family = context.registeredGantryToolFamilies.get(hookInput.tool_name);
    if (family) {
      context.gantryToolFamiliesByInvocation.set(hookInput.tool_use_id, family);
    }
  }
  return { continue: true as const };
}

export function prepareSdkQuery(context: QueryLoopContext): Query {
  const systemPrompt = buildRunnerSystemPrompt(context.agentInput, context.memoryBlock);
  const localCliCredentialDirectories = [
    ...new Set([
      ...readLocalCliCredentialDirectories(),
      ...localCliCredentialDirectoriesFromRuntimeAccess(context.agentInput),
    ]),
  ].sort();
  const extraDirs = discoverAdditionalDirectories();
  const additionalDirectories = [...new Set([...extraDirs, ...localCliCredentialDirectories])].sort();
  // Two-axis model (decision 0040): `direct` = authorization is the whole control
  // (permission engine + classifier + host-side credential/protected-path rail);
  // no inner SDK Seatbelt, so Chromium's Mach-port register (and the whole class)
  // runs. `sandbox_runtime` confinement is the runner OS sandbox
  // (runner-sandbox-provider), which is applied out-of-band — this SDK-level
  // filesystem Seatbelt is never the confinement layer, so it is dropped.
  const sdkFilesystemSandbox = undefined;
  const workspaceFolder = context.agentInput.workspaceFolder;
  const enabledSdkSkills = readClaudeSdkSkillNamesFromEnv();
  const isolatedSdkEnv: Record<string, string | undefined> = { ...context.sdkEnv, ...SDK_NATIVE_SKILL_DISABLE_ENV, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' };
  const claudeCodeExecutable =
    process.env.GANTRY_SANDBOX_RUNTIME_PROXY === '1'
      ? allowedOuterSandboxClaudeExecutable(
          resolveClaudeCodeExecutableFromPath(isolatedSdkEnv.PATH),
        )
      : undefined;
  const agentInput = context.agentInput;
  // prettier-ignore
  const capabilities = composeAgentCapabilities({
    mcpServerPath: context.mcpServerPath, appId: agentInput.appId, agentId: agentInput.agentId,
    providerAccountId: process.env.GANTRY_PROVIDER_ACCOUNT_ID, chatJid: agentInput.chatJid,
    workspaceFolder, threadId: agentInput.threadId, jobId: agentInput.jobId,
    runHandle: process.env.GANTRY_AGENT_RUN_HANDLE, runId: agentInput.runId,
    parentTaskId: agentInput.parentTaskId, callableAgentManifest: agentInput.callableAgentManifest,
    runLeaseToken: agentInput.runLeaseToken, runLeaseFencingVersion: agentInput.runLeaseFencingVersion,
    liveStopActionToken: process.env.GANTRY_LIVE_STOP_ACTION_TOKEN,
    memoryUserId: agentInput.memoryUserId, memoryDefaultScope: agentInput.memoryDefaultScope,
    memoryReviewerIsControlApprover: agentInput.memoryReviewerIsControlApprover,
    persona: agentInput.persona, browserProfileName: agentInput.browserProfileName,
    browserTurnToken: agentInput.browserTurnToken, configuredAllowedTools: agentInput.allowedTools,
    attachedSkillSourceIds: agentInput.attachedSkillSourceIds, selectedSkillDisplays: agentInput.selectedSkillDisplays,
    attachedMcpSourceIds: agentInput.attachedMcpSourceIds, semanticCapabilities: agentInput.semanticCapabilities,
    hideAuthorityTools: agentInput.hideAuthorityTools === true,
    asyncTaskToolsEnabled: process.env.GANTRY_ASYNC_TASK_TOOLS_ENABLED === '1',
    memoryBlock: context.memoryBlock,
    accessPreset: process.env.GANTRY_AGENT_ACCESS_PRESET === 'locked' ? 'locked' : 'full',
    ipcDir: process.env.GANTRY_IPC_DIR, ipcAuthToken: process.env.GANTRY_IPC_AUTH_TOKEN,
    attachmentIpcAuthToken: process.env.GANTRY_ATTACHMENT_IPC_AUTH_TOKEN,
    browserIpcAuthToken: process.env.GANTRY_BROWSER_IPC_AUTH_TOKEN,
    memoryIpcAuthToken: process.env.GANTRY_MEMORY_IPC_AUTH_TOKEN,
    ipcResponseVerifyKey: process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY,
    ipcResponseKeyId: process.env.GANTRY_IPC_RESPONSE_KEY_ID,
    externalMcpServers: readExternalMcpServers(), externalMcpAllowedTools: readExternalMcpAllowedTools(),
    externalMcpAlwaysAllowedTools: readExternalMcpAlwaysAllowedTools(), isScheduledJob: agentInput.isScheduledJob,
  });
  context.capabilities = capabilities;
  for (const toolName of capabilities.gantryOwnedTools) {
    const family = gantryOwnedToolActivityFamily(toolName);
    if (family) context.registeredGantryToolFamilies.set(toolName, family);
  }
  context.sdkQueryPreparedMs = context.elapsedMs();
  log(
    `SDK query prepared in ${context.sdkQueryPreparedMs}ms ` +
      `(tools=${capabilities.availableTools.length} mcpServers=${Object.keys(capabilities.mcpServers ?? {}).length})`,
  );
  // prettier-ignore
  const toolSearchDecision = decideClaudeSdkToolSearch({ sdkEnv: isolatedSdkEnv, availableTools: capabilities.availableTools, allowedTools: capabilities.allowedTools, disallowedTools: capabilities.disallowedTools, mcpServers: capabilities.mcpServers });
  context.toolSearchDecision = toolSearchDecision;
  isolatedSdkEnv.ENABLE_TOOL_SEARCH = toolSearchDecision.enableToolSearch;
  log(
    `SDK ToolSearch ${toolSearchDecision.enableToolSearch} ` +
      `(reason=${toolSearchDecision.reason} tools=${toolSearchDecision.availableToolCount} ` +
      `mcpServers=${toolSearchDecision.mcpServerCount} bytes=${toolSearchDecision.serializedToolConfigBytes})`,
  );
  const postToolUseHook = createPostToolUseHook({
    ...(context.toolSuccessLedger
      ? { toolSuccessLedger: context.toolSuccessLedger }
      : {}),
    emitTerminalToolOutcome: (input) => emitTerminalToolOutcome(context, input),
    takeGantryOwnedToolActivityFamily: (providerInvocationId) => {
      const family = context.gantryToolFamiliesByInvocation.get(providerInvocationId);
      context.gantryToolFamiliesByInvocation.delete(providerInvocationId);
      return family;
    },
    postToolUse: context.permissionApprovalContext.postToolUse,
  });
  // prettier-ignore
  const permissionCanUseTool = createCanUseToolCallback({
    agentInput: context.agentInput, sdkEnv: isolatedSdkEnv, workspaceFolder, memoryBlock: context.memoryBlock,
    configuredModel: context.configuredModel, capabilities, primeToolAttempts: context.primeToolAttempts,
    getNewSessionId: () => context.newSessionId,
    emitInteractionBoundary: () => emitInteractionBoundary(context),
    recordToolActivity: (toolName) => context.heartbeat.recordToolActivity(toolName),
    recordPermissionApprovalContext: context.permissionApprovalContext.record,
  });
  const declarativePreToolUse = createDeclarativePreToolUse(context);
  const sdkQuery = query({
    prompt: context.stream,
    options: {
      model: context.configuredModel, thinking: context.queryThinking,
      effort: context.queryEffort, cwd: WORKSPACE_GROUP_DIR,
      additionalDirectories:
        additionalDirectories.length > 0 ? additionalDirectories : undefined,
      persistSession: context.persistSdkSession,
      ...(context.persistSdkSession && context.agentInput.sessionId
        ? { resume: context.agentInput.sessionId }
        : {}),
      systemPrompt,
      settings: { autoMemoryEnabled: false, includeGitInstructions: false, skillOverrides: SDK_NATIVE_SKILL_OVERRIDES },
      skills: enabledSdkSkills, tools: [...capabilities.availableTools],
      disallowedTools: [...capabilities.disallowedTools], env: isolatedSdkEnv,
      // Without this the subprocess's own stderr is lost and startup failures
      // surface only as "Claude Code process exited with code 1".
      stderr: (data: string) => log(`[claude-code stderr] ${data}`),
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
              createSafetyPreToolUseHook(context.memoryBlock, context.agentInput.toolNetworkEnv ?? {}),
              (hookInput) => bindGantryToolRegistrationProvenance(context, hookInput),
              ...(declarativePreToolUse ? [declarativePreToolUse] : []),
            ],
            timeout: 5,
          },
        ],
        PostToolUse: [{ hooks: [postToolUseHook] }],
        PostToolUseFailure: [{ hooks: [postToolUseHook] }],
      },
      canUseTool: async (toolName, toolInput, permissionOptions) => {
        const decision = await permissionCanUseTool(
          toolName,
          toolInput,
          permissionOptions,
        );
        const invocationId = permissionOptions.toolUseID;
        if (decision.behavior === 'deny' && invocationId) {
          emitTerminalToolOutcome(context, {
            invocationId,
            toolName,
            outcome: 'failure',
          });
          return decision;
        }
        return decision;
      },
      // Load only the per-run CLAUDE_CONFIG_DIR settings so Claude discovers
      // Gantry-materialized skills without reading workspace configuration.
      settingSources: ['user'],
      mcpServers: capabilities.mcpServers,
      strictMcpConfig: true,
      includePartialMessages: true,
    },
  });
  context.sdkQuery = sdkQuery;
  context.sdkQueryIteratorMs = context.elapsedMs();
  log(`SDK query iterator created in ${context.sdkQueryIteratorMs}ms`);
  return sdkQuery;
}

function emitStartupTimingDiagnostic(context: QueryLoopContext): void {
  if (context.startupTimingDiagnosticEmitted) return;
  context.startupTimingDiagnosticEmitted = true;
  const capabilities = context.capabilities!;
  writeOutput({
    status: 'success',
    result: null,
    newSessionId: context.newSessionId,
    runtimeEventOnly: true,
    runtimeEvents: [
      runnerStartupTimingRuntimeEvent({
        agentInput: context.agentInput,
        persistSdkSession: context.persistSdkSession,
        resumedSession:
          context.persistSdkSession && Boolean(context.agentInput.sessionId),
        sdkQueryPreparedMs: context.sdkQueryPreparedMs!,
        sdkQueryIteratorMs: context.sdkQueryIteratorMs!,
        firstSdkEventMs: context.firstSdkEventMs,
        providerSessionMs: context.providerSessionMs,
        firstVisibleOutputMs: context.firstVisibleOutputMs,
        firstResultMs: context.firstResultMs,
        messageCount: context.messageCount,
        resultCount: context.resultCount,
        availableToolCount: capabilities.availableTools.length,
        allowedToolCount: capabilities.allowedTools.length,
        disallowedToolCount: capabilities.disallowedTools.length,
        mcpServerCount: Object.keys(capabilities.mcpServers ?? {}).length,
      }),
    ],
  });
}

export function beginQueryLoopMessage(context: QueryLoopContext, message: SDKMessage): void {
  context.messageCount++;
  context.heartbeat.markActivity();
  const msgType =
    message.type === 'system'
      ? `system/${(message as { subtype?: string }).subtype}`
      : message.type;
  // api_retry/auth errors carry the reason in the payload; without it a
  // failing turn logs an undiagnosable retry loop.
  const errorDetail = (message as { error?: unknown; error_status?: unknown })
    .error_status
    ? ` error_status=${String((message as { error_status?: unknown }).error_status)} error=${String((message as { error?: unknown }).error ?? '')}`
    : '';
  log(`[msg #${context.messageCount}] type=${msgType}${errorDetail}`);
  if (!context.firstSdkMessageLogged) {
    context.firstSdkMessageLogged = true;
    context.firstSdkEventMs = context.elapsedMs();
    log(`First SDK message after ${context.firstSdkEventMs}ms`);
  }
}

export function handleAssistantMessage(context: QueryLoopContext, message: AssistantMessage): void {
  if (message.type === 'assistant' && 'uuid' in message) {
    context.lastAssistantUuid = (message as { uuid: string }).uuid;
  }
  if (message.type === 'assistant') {
    if (hasTopLevelAssistantContent(message)) {
      context.sawAssistantContentSinceLastResult = true;
    }
    const assistantText = topLevelAssistantText(message);
    if (assistantText && !context.sawPartialTextSinceLastResult) {
      if (!context.firstTextDeltaLogged) {
        context.firstTextDeltaLogged = true;
        context.firstVisibleOutputMs = context.elapsedMs();
        log(`First SDK assistant text after ${context.firstVisibleOutputMs}ms`);
      }
      const visibleText = shouldPrefixVisibleBoundary(
        context.visibleTextSinceLastResult,
        assistantText,
      )
        ? `\n\n${assistantText}`
        : assistantText;
      context.sawStructuredTextSinceLastResult = true;
      context.pendingStructuredToPartialBoundary = true;
      context.visibleTextSinceLastResult += visibleText;
      writeOutput({ status: 'success', result: visibleText, newSessionId: context.newSessionId });
      emitStartupTimingDiagnostic(context);
    }
  }
}

export function handleSystemMessage(context: QueryLoopContext, message: SystemMessage): void {
  if (message.type === 'system' && message.subtype === 'init') {
    context.newSessionId = message.session_id;
    assertRequiredMcpServerReady(message);
    context.providerSessionMs = context.elapsedMs();
    log(
      `Session initialized after ${context.providerSessionMs}ms: provider resume handle received`,
    );
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: context.newSessionId,
      runtimeEventOnly: true,
      runtimeEvents: [
        toolSearchStartupRuntimeEvent({
          agentInput: context.agentInput,
          decision: context.toolSearchDecision!,
        }),
      ],
    });
  }
  if (
    message.type === 'system' &&
    (message as { subtype?: string }).subtype === 'compact_boundary'
  ) {
    log('SDK compact boundary observed');
    writeOutput({ status: 'success', result: null, newSessionId: context.newSessionId, compactBoundary: true });
  }
  const taskEvent =
    message.type === 'system'
      ? taskRuntimeEvent(
          context.agentInput,
          message as Record<string, unknown>,
        )
      : null;
  if (taskEvent) {
    const payload = taskEvent.payload as Record<string, unknown>;
    log(`Task event: type=${taskEvent.eventType} task=${payload.taskId}`);
    writeOutput({ status: 'success', result: null, runtimeEventOnly: true, runtimeEvents: [taskEvent] });
  }
}

export function handleStreamEvent(context: QueryLoopContext, message: StreamEventMessage): void {
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
        if (!context.firstTextDeltaLogged) {
          context.firstTextDeltaLogged = true;
          context.firstVisibleOutputMs = context.elapsedMs();
          log(`First SDK text delta after ${context.firstVisibleOutputMs}ms`);
        }
        const visibleText =
          context.pendingStructuredToPartialBoundary &&
          shouldPrefixVisibleBoundary(
            context.visibleTextSinceLastResult,
            delta.text,
          )
            ? `\n\n${delta.text}`
            : delta.text;
        context.pendingStructuredToPartialBoundary = false;
        context.sawPartialTextSinceLastResult = true;
        context.visibleTextSinceLastResult += visibleText;
        writeOutput({ status: 'success', result: visibleText, newSessionId: context.newSessionId });
        if (context.firstVisibleOutputMs !== undefined)
          emitStartupTimingDiagnostic(context);
      }
    }
  }
}

function writeResultOutput(context: QueryLoopContext, message: ResultMessage, textResult: string | null | undefined, canUseResultFallback: boolean, continuedByFollowup: boolean, usage: ReturnType<typeof normalizeModelUsage>): void {
  writeOutput({
    status: 'success', result: textResult && canUseResultFallback ? textResult : null,
    newSessionId: context.newSessionId,
    ...(context.primeToolAttempts.length > 0
      ? { primeToolAttempts: context.primeToolAttempts }
      : {}),
    ...(continuedByFollowup ? { continuedByFollowup: true } : {}),
    ...(usage
      ? {
          usage,
          usageEventId: usageEventIdForMessage(message, context.newSessionId ?? context.agentInput.sessionId, context.resultCount, context.queryRunId),
        }
      : {}),
  });
}

export async function handleResultMessage(context: QueryLoopContext, message: ResultMessage): Promise<void> {
  if (message.type === 'result') {
    context.resultCount++;
    if (context.resultCount === 1) {
      context.firstResultMs = context.elapsedMs();
      log(`First SDK result after ${context.firstResultMs}ms`);
    }
    const textResult =
      'result' in message ? (message as { result?: string }).result : null;
    const emittedVisibleText =
      context.sawPartialTextSinceLastResult ||
      context.sawStructuredTextSinceLastResult;
    const canUseResultFallback =
      !emittedVisibleText && !context.sawAssistantContentSinceLastResult;
    const resultFailure = sdkResultFailureMessage(message);
    if (resultFailure) {
      throw new Error(resultFailure);
    }
    if (canUseResultFallback && textResult) {
      context.firstVisibleOutputMs ??= context.firstResultMs;
    }
    const loggedResultText = canUseResultFallback ? textResult : null;
    log(
      `Result #${context.resultCount}: subtype=${message.subtype}${loggedResultText ? ` text=${loggedResultText.slice(0, 200)}` : ''}`,
    );
    logUsage(message);
    const usage = normalizeModelUsage({
      message,
      fallbackModel: context.configuredModel,
    });
    const contextUsagePromise = readContextUsage(context.sdkQuery!);
    const nudgeDeliveredThisTurn =
      context.agentInput.isScheduledJob &&
      !context.nudgedScheduledRunToFinish &&
      !context.closedDuringQuery &&
      !/\bOutcome:/i.test(
        context.visibleTextSinceLastResult || textResult || '',
      ) &&
      context.steeringGate.accept(
        'You stopped before finishing. Continue the task now. When you are finished, your final message must begin with a line "Outcome: <one sentence>".',
      ) !== 'closed';
    if (nudgeDeliveredThisTurn) {
      context.nudgedScheduledRunToFinish = true;
      log('Nudged scheduled run to finish: no Outcome line at turn end');
    }
    const continuedByFollowup = context.steeringGate.pendingCount() > 0;
    writeResultOutput(
      context,
      message,
      textResult,
      canUseResultFallback,
      continuedByFollowup,
      usage,
    );
    emitStartupTimingDiagnostic(context);
    context.sawPartialTextSinceLastResult = false;
    context.sawAssistantContentSinceLastResult = false;
    context.sawStructuredTextSinceLastResult = false;
    context.visibleTextSinceLastResult = '';
    context.pendingStructuredToPartialBoundary = false;
    context.steeringGate.markTurnBoundary();
    const scheduledOneShot = context.scheduledOneShot;
    const stream = context.stream;
    if (scheduledOneShot && !nudgeDeliveredThisTurn) stream.end();
    const contextUsage = await contextUsagePromise;
    if (contextUsage) {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: context.newSessionId,
        runtimeEventOnly: true,
        contextUsage,
      });
    }
  }
}

export function closeQueryLoop(context: QueryLoopContext): void {
  context.ipcPolling = false;
  context.runtimeSignalPump.stop();
  context.heartbeat.stop();
  context.steeringGate.close();
}

export function finishQueryLoop(context: QueryLoopContext) {
  if (
    context.messageCount === 0 &&
    context.resultCount === 0 &&
    !context.closedDuringQuery
  )
    throw new Error(
      context.persistSdkSession && context.agentInput.sessionId
        ? `No conversation found with session ID: ${context.agentInput.sessionId}`
        : 'Anthropic SDK query completed without messages or results',
    );
  log(
    `Query done. Messages: ${context.messageCount}, results: ${context.resultCount}, lastAssistantUuid: ${context.lastAssistantUuid || 'none'}, closedDuringQuery: ${context.closedDuringQuery}`,
  );
  return {
    newSessionId: context.newSessionId,
    lastAssistantUuid: context.lastAssistantUuid,
    closedDuringQuery: context.closedDuringQuery,
    primeToolAttempts: context.primeToolAttempts,
  };
}
