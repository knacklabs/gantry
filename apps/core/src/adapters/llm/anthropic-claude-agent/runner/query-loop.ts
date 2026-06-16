import {
  query,
  startup,
  type EffortLevel,
  type Options,
  type Query,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { composeAgentCapabilities } from '../agent-capabilities.js';
import { awaitBind, type ConversationBindScope } from './bind-channel.js';
import { writeBoundIdentityFile } from '../../../../runner/mcp/bound-identity.js';
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
import { timingMark } from './timing-probe.js';
import { LlmTurnAccumulator } from './llm-turn-accumulator.js';
import {
  buildSdkFilesystemSandbox,
  normalizeFilesystemSandboxPaths,
  readLocalCliCredentialDirectories,
  readProtectedFilesystemSandboxPaths,
} from './filesystem-sandbox.js';
import { createSafetyPreToolUseHook } from './protected-capability-hook.js';
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
import { normalizeModelUsage } from '../../../../shared/model-usage.js';
import { usageEventIdForMessage } from './query-usage-event-id.js';
import {
  ensureRequiredMcpServerReady,
  readExternalMcpServers,
  type McpServerStatusSample,
} from './mcp-server-validation.js';
import {
  readExternalMcpAllowedTools,
  readExternalMcpAlwaysAllowedTools,
} from './external-mcp-tool-rules.js';
import { startJobHeartbeat } from './job-heartbeat.js';
import { logUsage } from './usage-logging.js';
import {
  formatRateLimitLogLine,
  rateLimitRuntimeEvent,
  sdkRateLimitSnapshot,
} from './model-telemetry.js';
import { readContextUsage } from './context-usage.js';
import { createDeferredContextUsageEmitter } from './context-usage-emitter.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { createCanUseToolCallback } from './tool-permission-gate.js';

interface RunQueryOptions {
  enableIpcFollowups?: boolean;
  persistSdkSession?: boolean;
  /**
   * Warm-pool (Pillar 2, F3): boot the SDK generic via `startup()`, await the
   * per-customer bind, then run `warmQuery.query(stream)`. The bound first
   * message + memory block ride the stream (NOT the boot system prompt).
   */
  warmGenericBoot?: boolean;
}

function localCliCredentialDirectoriesFromRuntimeAccess(
  agentInput: AgentRunnerInput,
): string[] {
  const dirs = (agentInput.runtimeAccess ?? []).flatMap((access) =>
    access.sourceType === 'local_cli' ? access.credentialDirs : [],
  );
  return normalizeFilesystemSandboxPaths(dirs);
}

function sdkResultFailureMessage(message: unknown): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const resultMessage = message as {
    subtype?: string;
    is_error?: boolean;
    result?: string;
    errors?: unknown;
  };
  const errors = Array.isArray(resultMessage.errors)
    ? resultMessage.errors.filter((error): error is string => {
        return typeof error === 'string' && error.trim().length > 0;
      })
    : [];
  const text =
    typeof resultMessage.result === 'string' ? resultMessage.result : '';
  if (text) {
    const normalized = text.toLowerCase();
    const looksLikeCredentialFailure =
      normalized.includes('invalid api key') ||
      normalized.includes('external api key') ||
      normalized.includes('authentication failed') ||
      normalized.includes('failed to authenticate') ||
      normalized.includes('authentication_error') ||
      normalized.includes('invalid bearer token') ||
      normalized.includes('api error: 401');
    const looksLikeBillingFailure =
      normalized.includes('billing') ||
      normalized.includes('out of credits') ||
      normalized.includes('credit balance') ||
      normalized.includes('insufficient credit') ||
      normalized.includes('payment required');
    if (looksLikeCredentialFailure || looksLikeBillingFailure) {
      return text;
    }
  }
  if (resultMessage.subtype && resultMessage.subtype !== 'success') {
    return errors.length > 0
      ? errors.join('; ')
      : `Claude SDK result failed with subtype ${resultMessage.subtype}`;
  }
  if (resultMessage.is_error && errors.length > 0) {
    return errors.join('; ');
  }
  return null;
}

function messageContainsToolUse(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const candidates = [
    (message as { content?: unknown }).content,
    (message as { message?: { content?: unknown } }).message?.content,
  ];
  return candidates.some(
    (content) =>
      Array.isArray(content) &&
      content.some(
        (block) =>
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'tool_use',
      ),
  );
}

/** Concatenated text of an assistant message (the turn's visible output). */
function assistantOutputText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } }).message
    ?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('');
}

/**
 * Warm-pool two-phase dispatch (F3). Boots the SDK GENERIC via `startup()`
 * (CLI + MCP connect, no customer message), awaits the per-customer bind over a
 * non-stdin channel, pushes the bound first message + memory block (and the
 * guardrail preface, kept per-turn — Fix #2) onto the stream, then runs the
 * single warm query. `startup()`/`WarmQuery` is single-use = Model A.
 */
async function dispatchWarmQuery(args: {
  sdkOptions: Options;
  stream: MessageStream;
  guardrailPreface?: string;
  onBound: (scope: ConversationBindScope) => void;
}): Promise<Query> {
  const warm = await startup({ options: args.sdkOptions });
  log('Warm worker booted generic via startup(); awaiting bind');
  let scope: ConversationBindScope;
  try {
    scope = await awaitBind();
  } catch (err) {
    // Never leak a warm CLI subprocess if the bind never lands.
    try {
      warm.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
  // Publish the bound identity BEFORE running so the gantry-MCP child + the
  // runner's permission/messaging readers stamp the bound chatJid on the first
  // tool call (D-P2-2(a), F4). The shim source is a file under GANTRY_IPC_DIR;
  // the Pillar-1 socket replaces it at combine time.
  const ipcDir = process.env.GANTRY_IPC_DIR;
  if (ipcDir) {
    writeBoundIdentityFile(ipcDir, {
      chatJid: scope.chatJid,
      threadId: scope.threadId,
      memoryUserId: scope.memoryUserId,
      ipcAuthToken: scope.ipcAuthToken,
      browserIpcAuthToken: scope.browserIpcAuthToken,
      memoryIpcAuthToken: scope.memoryIpcAuthToken,
      ipcResponseKeyId: scope.ipcResponseKeyId,
      ipcResponseVerifyKey: scope.ipcResponseVerifyKey,
    });
  }
  // The guardrail preface + memory block ride the FIRST user message (not the
  // cached system prompt) so the shared prefix stays byte-identical across
  // customers (Fix #2 / spec §2.3). Memory is pushed first by pushInitialPrompt;
  // the guardrail preface, when present, leads the customer's first message.
  const guardrailPreface = args.guardrailPreface?.trim();
  const firstMessage = guardrailPreface
    ? `${guardrailPreface}\n\n${scope.firstMessage}`
    : scope.firstMessage;
  args.stream.pushInitialPrompt(firstMessage, scope.memoryBlock || undefined);
  args.onBound(scope);
  const sdkQuery = warm.query(args.stream);
  // Test-only (F10): prove the WarmQuery is single-use by attempting a second
  // query() — the SDK throws "Can only be called once per WarmQuery". Never
  // taken in production (Model A binds exactly once per worker).
  if (process.env.GANTRY_SPIKE_DOUBLE_QUERY === '1') {
    try {
      warm.query(args.stream);
    } catch (err) {
      log(
        `WarmQuery single-use verified: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return sdkQuery;
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
  const warmGenericBoot = options.warmGenericBoot ?? false;
  const stream = new MessageStream();
  const queryRunId = randomUUID();
  // Generic boot carries no customer memory at boot; the bound memory block
  // rides the stream after the bind (below). The cold path keeps today's
  // behavior: memory read from the input and pushed with the first prompt.
  const memoryBlock = warmGenericBoot ? '' : readMemoryContextBlock(agentInput);
  if (!warmGenericBoot) {
    stream.pushInitialPrompt(prompt, memoryBlock);
    if (!enableIpcFollowups) {
      stream.end();
    }
  }
  let ipcPolling = true;
  let closedDuringQuery = false;
  let newSessionId: string | undefined;
  // The customer message that drives the NEXT turn (for the reply trace's
  // per-turn input payload): the run prompt to begin with, then each warm-run
  // continuation as it is piped in. Consumed by the first turn that answers it
  // and cleared, so a turn's tool-loop follow-ons carry no input. For a warm
  // generic boot there is no boot-time prompt — it is set to the bound first
  // message after the bind below.
  let pendingTurnInput: string | undefined = warmGenericBoot
    ? undefined
    : prompt;
  // Warm-pool (F1): true once this run is bound to a customer from the pool, so
  // the result envelope emits `dispatchedAt` (post-bind pickup → TTFT) instead
  // of `runnerStartup` (whose firstSdkMessageAt predates bind).
  let warmBound = false;
  // Warm-pool (F4): the BOUND customer chatJid, captured at bind. On a generic
  // worker `agentInput.chatJid` is the boot-time generic value, so telemetry
  // that needs the real customer scope reads this when set (cold path leaves it
  // undefined and falls back to `agentInput.chatJid`, byte-identical).
  let boundChatJid: string | undefined;
  // Warm continuation: the instant this turn's input is delivered to the model
  // (pushed to the SDK stream). Emitted per result so core can split the warm
  // leading span into real pickup (queue) + the model's first-token wait.
  let pendingTurnDispatchedAt: number | undefined;
  const steeringGate = new SteeringDeliveryGate((text) => {
    log(`Piping IPC message at turn boundary (${text.length} chars)`);
    pendingTurnInput = text;
    pendingTurnDispatchedAt = Date.now();
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
  let lastAssistantUuid: string | undefined;
  let queryDispatchedAt: number | undefined;
  let firstSdkMessageAt: number | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let sawPartialTextSinceLastResult = false;
  let pendingPartialText = '';
  const primeToolAttempts: AgentRunnerToolAttemptOutput[] = [];
  // Per-turn LLM latency + token capture for the reply trace (best-effort).
  // Payloads (input/output text) only when GANTRY_TRACE_PAYLOADS=1.
  const capturePayloads = process.env['GANTRY_TRACE_PAYLOADS']?.trim() === '1';
  const llmTurns = new LlmTurnAccumulator({ capturePayloads });
  const heartbeat = startJobHeartbeat({
    agentInput,
    writeOutput,
    getSessionId: () => newSessionId,
  });
  const externalMcpServers = readExternalMcpServers();
  const externalMcpAllowedTools = readExternalMcpAllowedTools();
  const externalMcpAlwaysAllowedTools = readExternalMcpAlwaysAllowedTools();
  const systemPrompt = buildRunnerSystemPrompt(
    agentInput,
    memoryBlock,
    {
      approvedMcpServerNames: Object.keys(externalMcpServers),
    },
    // Generic boot keeps the guardrail OUT of the cached prefix (Fix #2); it is
    // prepended to the bound first message in dispatchWarmQuery instead.
    { genericBoot: warmGenericBoot },
  );
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
  const workspaceFolder = agentInput.groupFolder;
  const enabledSdkSkills = readClaudeSdkSkillNamesFromEnv();
  const isolatedSdkEnv = {
    ...sdkEnv,
    ...SDK_NATIVE_SKILL_DISABLE_ENV,
  };
  const capabilities = composeAgentCapabilities({
    mcpServerPath,
    appId: agentInput.appId,
    agentId: agentInput.agentId,
    chatJid: agentInput.chatJid,
    groupFolder: workspaceFolder,
    threadId: agentInput.threadId,
    memoryUserId: agentInput.memoryUserId,
    memoryDefaultScope: agentInput.memoryDefaultScope,
    memoryReviewerIsControlApprover: agentInput.memoryReviewerIsControlApprover,
    persona: agentInput.persona,
    browserProfileName: agentInput.browserProfileName,
    configuredAllowedTools: agentInput.allowedTools,
    gantryMcpToolSurface: agentInput.gantryMcpToolSurface,
    nativeToolSurface: agentInput.nativeToolSurface,
    attachedSkillSourceIds: agentInput.attachedSkillSourceIds,
    selectedSkillDisplays: agentInput.selectedSkillDisplays,
    attachedMcpSourceIds: agentInput.attachedMcpSourceIds,
    semanticCapabilities: agentInput.semanticCapabilities,
    ipcDir: process.env.GANTRY_IPC_DIR,
    ipcAuthToken: process.env.GANTRY_IPC_AUTH_TOKEN,
    browserIpcAuthToken: process.env.GANTRY_BROWSER_IPC_AUTH_TOKEN,
    memoryIpcAuthToken: process.env.GANTRY_MEMORY_IPC_AUTH_TOKEN,
    ipcResponseVerifyKey: process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY,
    ipcResponseKeyId: process.env.GANTRY_IPC_RESPONSE_KEY_ID,
    externalMcpServers,
    externalMcpAllowedTools,
    externalMcpAlwaysAllowedTools,
    isScheduledJob: agentInput.isScheduledJob,
  });
  const sdkOptions: Options = {
    model: configuredModel,
    thinking: queryThinking,
    effort: queryEffort,
    cwd: WORKSPACE_GROUP_DIR,
    additionalDirectories:
      additionalDirectories.length > 0 ? additionalDirectories : undefined,
    persistSession: persistSdkSession,
    // Generic boot omits `resume` (fresh session); returning-customer resume is
    // a cold-spawn fallback (spec §6.4 D-P2-1(b)).
    ...(!warmGenericBoot && persistSdkSession && agentInput.sessionId
      ? { resume: agentInput.sessionId }
      : {}),
    systemPrompt,
    settings: {
      autoMemoryEnabled: false,
      includeGitInstructions: includeGitInstructionsForPersona(
        agentInput.persona,
      ),
      skillOverrides: SDK_NATIVE_SKILL_OVERRIDES,
    },
    skills: enabledSdkSkills,
    tools: [...capabilities.availableTools],
    allowedTools: [...capabilities.allowedTools],
    disallowedTools: [...capabilities.disallowedTools],
    env: isolatedSdkEnv,
    sandbox: buildSdkFilesystemSandbox(protectedFilesystemDenyWritePaths, {
      denyReadPaths: protectedFilesystemDenyReadPaths,
      denyWritePaths: protectedFilesystemDenyWritePaths,
    }),
    permissionMode: capabilities.permissionMode,
    hooks: {
      PreToolUse: [
        {
          hooks: [createSafetyPreToolUseHook(memoryBlock)],
          timeout: 5,
        },
      ],
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
      recordToolActivity: (toolName) => heartbeat.recordToolActivity(toolName),
    }),
    settingSources: ['user'] as const,
    mcpServers: capabilities.mcpServers,
    includePartialMessages: true,
  };
  // MEASUREMENT-ONLY: just before the SDK spawns the Claude Code CLI subprocess.
  timingMark('before_sdk_query');
  queryDispatchedAt = Date.now();
  // Two-phase warm-pool entry (F3): boot the CLI/MCP tree GENERIC via
  // startup(), await the per-customer bind over a non-stdin channel, push the
  // bound first message + memory onto the stream, then run the SINGLE warm
  // query. The cold path is byte-identical (plain query() from stdin).
  const sdkQuery = warmGenericBoot
    ? await dispatchWarmQuery({
        sdkOptions,
        stream,
        guardrailPreface: agentInput.guardrailSystemPromptAppend,
        onBound: (scope) => {
          warmBound = true;
          boundChatJid = scope.chatJid;
          pendingTurnInput = scope.firstMessage;
          pendingTurnDispatchedAt = Date.now();
        },
      })
    : query({ prompt: stream, options: sdkOptions });
  // Context usage is diagnostics-only (model-status store / session-command
  // display) but its fetch round-trips the CLI (0.7-4.1s measured). It is
  // emitted as a follow-up envelope so the reply envelope is never held back.
  const contextUsageEmitter = createDeferredContextUsageEmitter({
    readUsage: () => readContextUsage(sdkQuery),
    write: writeOutput,
    getSessionId: () => newSessionId,
  });
  try {
    for await (const message of sdkQuery) {
      messageCount++;
      // MEASUREMENT-ONLY: first message from the SDK == CLI subprocess booted &
      // MCP servers connected (system/init). Diff from before_sdk_query.
      if (messageCount === 1) {
        timingMark('first_sdk_message');
        firstSdkMessageAt = Date.now();
      }
      heartbeat.markActivity();
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);
      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
        // Per-turn latency/usage capture (best-effort). Wall-clock Date.now()
        // is comparable with the core MCP-call timestamps on this single host,
        // so stages merge by start time across the child/core boundary.
        llmTurns.onAssistant(
          message as Parameters<typeof llmTurns.onAssistant>[0],
          Date.now(),
          capturePayloads
            ? {
                output: assistantOutputText(message),
                // The driving message (run prompt, or the warm-run continuation
                // just piped in) belongs to the turn that answers it; tool-loop
                // follow-ons of the same message carry no fresh input.
                ...(pendingTurnInput !== undefined
                  ? { input: pendingTurnInput }
                  : {}),
              }
            : undefined,
        );
        pendingTurnInput = undefined;
        if (messageContainsToolUse(message)) {
          pendingPartialText = '';
        }
      }
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        // The SDK (>= 0.3.156) emits init before stdio MCP servers finish
        // connecting, so the init snapshot may report `gantry` as `pending`.
        // Poll the live status (when the handle supports it) instead of
        // failing on the snapshot.
        const statusReporter = sdkQuery as {
          mcpServerStatus?: () => Promise<McpServerStatusSample[]>;
        };
        await ensureRequiredMcpServerReady(message, {
          getLiveStatuses:
            typeof statusReporter.mcpServerStatus === 'function'
              ? () => statusReporter.mcpServerStatus!()
              : undefined,
        });
        log('Session initialized: provider resume handle received');
        writeOutput({
          status: 'success',
          result: null,
          newSessionId,
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
      if (message.type === 'rate_limit_event') {
        // Account-pressure telemetry: the same pipeline runs 2-4x slower near
        // the credential's rate-limit window cap, so every session records the
        // utilization it ran under (log line + durable runtime event).
        const rateLimit = sdkRateLimitSnapshot(message);
        if (!rateLimit) {
          // The wire shape comes from the bundled CLI, not sdk.d.ts — if it
          // drifts, say so instead of silently dropping the telemetry.
          log(
            `rate_limit_event with unrecognized shape: ${JSON.stringify(message).slice(0, 600)}`,
          );
        }
        if (rateLimit) {
          log(formatRateLimitLogLine(rateLimit));
          writeOutput({
            status: 'success',
            result: null,
            newSessionId,
            runtimeEvents: [
              rateLimitRuntimeEvent(
                {
                  appId: agentInput.appId,
                  agentId: agentInput.agentId,
                  runId: agentInput.runId,
                  jobId: agentInput.jobId,
                  // Warm path: the bound customer scope (F4); cold path falls
                  // back to the boot-time generic value.
                  chatJid: boundChatJid ?? agentInput.chatJid,
                  threadId: agentInput.threadId,
                },
                rateLimit,
                newSessionId ?? agentInput.sessionId,
              ),
            ],
          });
        }
      }
      if (message.type === 'stream_event') {
        const event = (message as { event?: unknown }).event as
          | {
              type?: string;
              delta?: {
                type?: string;
                text?: string;
                stop_reason?: string | null;
              };
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            }
          | undefined;
        // message_start fires when the model BEGINS generating this turn (before
        // any content); the assistant message only arrives once generation is
        // done. Stamp the turn's start here so its duration reflects real
        // generation time and excludes the inter-turn gap (tool calls). Verified
        // ordering: message_start → content deltas → assistant → message_delta.
        if (event?.type === 'message_start') {
          llmTurns.onTurnStart(Date.now());
        }
        if (event?.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            sawPartialTextSinceLastResult = true;
            pendingPartialText += delta.text;
          }
        }
        // The message_delta event carries the message's FINAL token usage (esp.
        // output_tokens — the assistant event only had a mid-stream snapshot).
        // Apply it to the open LLM turn so the trace shows accurate per-turn
        // tokens. Best-effort.
        if (event?.type === 'message_delta') {
          llmTurns.onFinalUsage(event.usage, event.delta?.stop_reason);
        }
      }
      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        const resultFailure = sdkResultFailureMessage(message);
        if (resultFailure) {
          throw new Error(resultFailure);
        }
        log(
          `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        logUsage(message);
        // The result marks a turn boundary — close the open LLM turn so its
        // duration is measured to here. Best-effort; never affects the reply.
        llmTurns.closeOpenTurn(Date.now());
        const usage = normalizeModelUsage({
          message,
          fallbackModel: configuredModel,
        });
        const turns = llmTurns.turns();
        const continuedByFollowup = steeringGate.pendingCount() > 0;
        if (pendingPartialText) {
          writeOutput({
            status: 'success',
            result: pendingPartialText,
            newSessionId,
          });
        }
        writeOutput({
          status: 'success',
          result:
            textResult && !sawPartialTextSinceLastResult ? textResult : null,
          newSessionId,
          ...(primeToolAttempts.length > 0 ? { primeToolAttempts } : {}),
          ...(continuedByFollowup ? { continuedByFollowup: true } : {}),
          ...(turns.length > 0 ? { turns } : {}),
          ...(warmBound ? { warmBound: true } : {}),
          // F1: a warm-bound run booted BEFORE bind, so firstSdkMessageAt
          // predates the customer's message and runnerStartup would mis-route
          // the trace (lumping the lead as one queue with no model_wait split).
          // Suppress it; the post-bind dispatchedAt below carries the real
          // pickup → first-token mark instead, exactly like a warm continuation.
          ...(!warmBound && firstSdkMessageAt !== undefined
            ? { runnerStartup: { queryDispatchedAt, firstSdkMessageAt } }
            : {}),
          ...(pendingTurnDispatchedAt !== undefined
            ? { dispatchedAt: pendingTurnDispatchedAt }
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
        contextUsageEmitter.emitAfterResult();
        sawPartialTextSinceLastResult = false;
        pendingPartialText = '';
        steeringGate.markTurnBoundary();
      }
    }
  } finally {
    ipcPolling = false;
    heartbeat.stop();
    steeringGate.close();
  }
  // Give the last deferred context-usage emission a bounded chance to land
  // before the process exits; never stall shutdown on a hung CLI.
  await contextUsageEmitter.flush(3_000);
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
