import {
  query,
  startup,
  type EffortLevel,
  type Options,
  type Query,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { composeAgentCapabilities } from '../agent-capabilities.js';
import {
  acceptSocketBindPayload,
  awaitBind,
  type ConversationBindScope,
} from './bind-channel.js';
import {
  setInMemoryBoundIdentity,
  writeBoundIdentityFile,
  writeBoundIdentityFilePath,
} from '../../../../runner/mcp/bound-identity.js';
import {
  SDK_NATIVE_SKILL_DISABLE_ENV,
  SDK_NATIVE_SKILL_OVERRIDES,
  claudeSdkToolsForEnabledSkills,
  readClaudeSdkProgressiveSkillNamesFromEnv,
  readClaudeSdkSkillNamesFromEnv,
} from '../native-sdk-skills.js';
import { MessageStream } from './message-stream.js';
import { SteeringDeliveryGate } from './steering-delivery-gate.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import {
  assistantOutputText,
  selectToolUsePreamble,
} from './assistant-output.js';
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
  AGENT_ID,
  APP_ID,
  discoverAdditionalDirectories,
  GROUP_FOLDER,
  IPC_AUTH_TOKEN,
  IPC_RESPONSE_KEY_ID,
  IPC_RESPONSE_VERIFY_KEY,
  RUN_HANDLE,
  THREAD_ID,
  WORKSPACE_GROUP_DIR,
} from './runtime-env.js';
import { IpcSocketClient } from '../../../../shared/ipc-socket-client.js';
import type { IpcWireFrame } from '../../../../shared/ipc-wire.js';
import { replaceCachedLiveToolRulesFromPayload } from '../../../../shared/live-tool-rules.js';
import {
  createSignedIpcRequestEnvelope,
  verifyIpcResponsePayload,
} from './ipc-signing.js';
import { setActiveRunnerSocketClient } from './active-runner-socket.js';
import {
  buildRunnerSystemPrompt,
  includeGitInstructionsForPersona,
  readMemoryContextBlock,
} from './system-prompt.js';
import type {
  AgentRunnerInput,
  AgentRunnerToolCall,
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
import { writeSdkQueryArgsPayloadLogs } from './sdk-query-args-log.js';

interface RunQueryOptions {
  enableIpcFollowups?: boolean;
  persistSdkSession?: boolean;
  /**
   * Warm-pool (Pillar 2): boot the SDK generic via `startup()`, await the
   * per-customer bind, then run `warmQuery.query(stream)`.
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

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sdkToolIdentity(
  name: string,
  input: unknown,
): { server: string; tool: string } {
  const obj = plainObject(input);
  const serverName = stringValue(obj?.serverName ?? obj?.server_name);
  const toolName = stringValue(obj?.toolName ?? obj?.tool_name);
  if (serverName && toolName) {
    return { server: serverName, tool: toolName };
  }

  const mcpMatch = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcpMatch) {
    return { server: mcpMatch[1]!, tool: mcpMatch[2]! };
  }

  return { server: 'sdk', tool: name };
}

function assistantToolUses(message: unknown): Array<{
  id: string;
  name: string;
  input?: unknown;
}> {
  const content = (message as { message?: { content?: unknown } }).message
    ?.content;
  if (!Array.isArray(content)) return [];
  const uses: Array<{ id: string; name: string; input?: unknown }> = [];
  for (const block of content) {
    const item = plainObject(block);
    if (!item || item.type !== 'tool_use') continue;
    const id = stringValue(item.id);
    const name = stringValue(item.name);
    if (!id || !name) continue;
    uses.push({
      id,
      name,
      ...(Object.prototype.hasOwnProperty.call(item, 'input')
        ? { input: item.input }
        : {}),
    });
  }
  return uses;
}

function userToolResults(message: unknown): Array<{
  id: string;
  ok: boolean;
  response?: unknown;
}> {
  const results: Array<{ id: string; ok: boolean; response?: unknown }> = [];
  const content = (message as { message?: { content?: unknown } }).message
    ?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const item = plainObject(block);
      if (!item || item.type !== 'tool_result') continue;
      const id = stringValue(item.tool_use_id);
      if (!id) continue;
      results.push({
        id,
        ok: item.is_error !== true,
        ...(Object.prototype.hasOwnProperty.call(item, 'content')
          ? { response: item.content }
          : {}),
      });
    }
  }

  const parentId = stringValue(
    (message as { parent_tool_use_id?: unknown }).parent_tool_use_id,
  );
  if (
    parentId &&
    !results.some((result) => result.id === parentId) &&
    Object.prototype.hasOwnProperty.call(
      message as Record<string, unknown>,
      'tool_use_result',
    )
  ) {
    results.push({
      id: parentId,
      ok: true,
      response: (message as { tool_use_result?: unknown }).tool_use_result,
    });
  }
  return results;
}

class SdkToolCallAccumulator {
  private readonly open = new Map<
    string,
    {
      startedAt: number;
      server: string;
      tool: string;
      requestBytes: number;
      request?: unknown;
    }
  >();
  private readonly completed: AgentRunnerToolCall[] = [];

  constructor(private readonly capturePayloads: boolean) {}

  onAssistant(message: unknown, at: number): void {
    for (const toolUse of assistantToolUses(message)) {
      const identity = sdkToolIdentity(toolUse.name, toolUse.input);
      this.open.set(toolUse.id, {
        startedAt: at,
        ...identity,
        requestBytes: byteLength(toolUse.input),
        ...(this.capturePayloads ? { request: toolUse.input } : {}),
      });
    }
  }

  onUser(message: unknown, at: number): void {
    for (const result of userToolResults(message)) {
      const open = this.open.get(result.id);
      if (!open) continue;
      this.open.delete(result.id);
      this.completed.push({
        server: open.server,
        tool: open.tool,
        startedAt: open.startedAt,
        ms: Math.max(0, at - open.startedAt),
        ok: result.ok,
        requestBytes: open.requestBytes,
        responseBytes: byteLength(result.response),
        ...(this.capturePayloads ? { request: open.request } : {}),
        ...(this.capturePayloads ? { response: result.response } : {}),
      });
    }
  }

  calls(): AgentRunnerToolCall[] {
    return this.completed;
  }
}

export function routeRunnerPushFrame(
  frame: IpcWireFrame,
  handlers: {
    onContinuation: (text: string) => void;
    onClose: () => void;
  },
): { closed: boolean } {
  if (frame.type === 'ctrl' && frame.ctrl === 'drain') {
    handlers.onClose();
    return { closed: true };
  }
  if (frame.channel === 'live_tool_rules') {
    replaceCachedLiveToolRulesFromPayload(frame.payload);
    return { closed: false };
  }
  if (frame.channel === 'bind') {
    acceptSocketBindPayload(frame.payload);
    return { closed: false };
  }
  if (frame.channel === 'close') {
    handlers.onClose();
    return { closed: true };
  }
  if (frame.channel !== 'continuation') {
    return { closed: false };
  }
  const text =
    frame.payload &&
    typeof frame.payload === 'object' &&
    typeof (frame.payload as { text?: unknown }).text === 'string'
      ? (frame.payload as { text: string }).text
      : undefined;
  if (text !== undefined) handlers.onContinuation(text);
  return { closed: false };
}

function traceableSdkStartupOptions(options: Options): Record<string, unknown> {
  return {
    model: options.model,
    thinking: options.thinking,
    effort: options.effort,
    cwd: options.cwd,
    additionalDirectories: options.additionalDirectories,
    persistSession: options.persistSession,
    systemPrompt: options.systemPrompt,
    settings: options.settings,
    skills: options.skills,
    tools: options.tools,
    allowedTools: options.allowedTools,
    disallowedTools: options.disallowedTools,
    env: options.env,
    sandbox: options.sandbox,
    permissionMode: options.permissionMode,
    mcpServers: options.mcpServers,
    includePartialMessages: options.includePartialMessages,
    settingSources: options.settingSources,
    debug: options.debug,
    debugFile: options.debugFile ? 'present' : undefined,
  };
}

type WarmCachePrewarmTrace = {
  kind: 'cache_prewarm';
  startedAt: number;
  ms: number;
  detail: Record<string, unknown>;
  payload: {
    cache: {
      provider: string;
      modelAlias?: string;
      promptShapeKey: string;
      cacheReadTokens: number;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
      capturedAt: string;
    };
  };
};

async function dispatchWarmQuery(args: {
  sdkOptions: Options;
  stream: MessageStream;
  guardrailPreface?: string;
  onBound: (scope: ConversationBindScope) => void;
  captureCachePrewarmPayloads: boolean;
}): Promise<{
  query: Query;
  effectiveFirstMessage: string;
  cachePrewarmTrace?: WarmCachePrewarmTrace;
}> {
  const startupStartedAt = Date.now();
  const warm = await startup({ options: args.sdkOptions });
  const startupEndedAt = Date.now();
  log('Warm worker booted generic via startup(); awaiting bind');
  const promptShapeKey =
    process.env.GANTRY_WARM_POOL_CACHE_SHAPE_KEY?.trim() || 'unknown';
  const cachePrewarmTrace = args.captureCachePrewarmPayloads
    ? {
        kind: 'cache_prewarm' as const,
        startedAt: startupStartedAt,
        ms: Math.max(0, startupEndedAt - startupStartedAt),
        detail: {
          provider: 'anthropic',
          status: 'succeeded',
          promptShapeKey,
        },
        payload: {
          cache: {
            provider: 'anthropic',
            ...(args.sdkOptions.model
              ? { modelAlias: args.sdkOptions.model }
              : {}),
            promptShapeKey,
            cacheReadTokens: 0,
            input: traceableSdkStartupOptions(args.sdkOptions),
            output: {
              status: 'succeeded',
              readyMarker: 'awaiting bind',
            },
            capturedAt: new Date(startupEndedAt).toISOString(),
          },
        },
      }
    : undefined;
  let scope: ConversationBindScope;
  try {
    scope = await awaitBind();
  } catch (err) {
    try {
      warm.close();
    } catch {
      // Best-effort cleanup only.
    }
    throw err;
  }

  const boundIdentity = {
    chatJid: scope.chatJid,
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    ...(scope.memoryUserId ? { memoryUserId: scope.memoryUserId } : {}),
    ...(scope.runHandle ? { runHandle: scope.runHandle } : {}),
    ...(scope.ipcAuthToken ? { ipcAuthToken: scope.ipcAuthToken } : {}),
    ...(scope.browserIpcAuthToken
      ? { browserIpcAuthToken: scope.browserIpcAuthToken }
      : {}),
    ...(scope.memoryIpcAuthToken
      ? { memoryIpcAuthToken: scope.memoryIpcAuthToken }
      : {}),
    ...(scope.ipcResponseKeyId
      ? { ipcResponseKeyId: scope.ipcResponseKeyId }
      : {}),
    ...(scope.ipcResponseVerifyKey
      ? { ipcResponseVerifyKey: scope.ipcResponseVerifyKey }
      : {}),
  };
  setInMemoryBoundIdentity(boundIdentity);
  const boundIdentityFile = process.env.GANTRY_BOUND_IDENTITY_FILE?.trim();
  if (boundIdentityFile) {
    writeBoundIdentityFilePath(boundIdentityFile, boundIdentity);
  } else if (process.env.GANTRY_IPC_DIR) {
    const ipcDir = process.env.GANTRY_IPC_DIR;
    writeBoundIdentityFile(ipcDir, boundIdentity);
  }

  const guardrailPreface = (
    scope.guardrailPreface ?? args.guardrailPreface
  )?.trim();
  const firstMessage = guardrailPreface
    ? `${guardrailPreface}\n\n${scope.firstMessage}`
    : scope.firstMessage;
  args.stream.pushInitialPrompt(firstMessage, scope.memoryBlock || undefined);
  args.onBound(scope);
  return {
    query: warm.query(args.stream),
    effectiveFirstMessage: firstMessage,
    ...(cachePrewarmTrace ? { cachePrewarmTrace } : {}),
  };
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
  const memoryBlock = warmGenericBoot ? '' : readMemoryContextBlock(agentInput);
  if (!warmGenericBoot) {
    stream.pushInitialPrompt(prompt, memoryBlock);
    if (!enableIpcFollowups) {
      stream.end();
    }
  }
  let closedDuringQuery = false;
  let newSessionId: string | undefined;
  // The customer message that drives the NEXT turn (for the reply trace's
  // per-turn input payload): the run prompt to begin with, then each warm-run
  // continuation as it is piped in. Consumed by the first turn that answers it
  // and cleared, so a turn's tool-loop follow-ons carry no input.
  let pendingTurnInput: string | undefined = warmGenericBoot
    ? undefined
    : prompt;
  let warmBound = false;
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
  const closeQueryStream = () => {
    closedDuringQuery = true;
    steeringGate.close();
    stream.end();
  };
  const ipcSocketPath = process.env.GANTRY_IPC_SOCKET_PATH;
  const useSocketIpc = !!ipcSocketPath;
  let ipcSocketClient: IpcSocketClient | undefined;
  if (useSocketIpc && ipcSocketPath) {
    ipcSocketClient = new IpcSocketClient({
      socketPath: ipcSocketPath,
      buildHello: () =>
        createSignedIpcRequestEnvelope(IPC_AUTH_TOKEN, {
          kind: 'hello',
          role: 'runner',
          runHandle: RUN_HANDLE,
          folder: GROUP_FOLDER || agentInput.groupFolder,
          context: {
            threadId: THREAD_ID || null,
            responseKeyId: IPC_RESPONSE_KEY_ID || null,
            appId: APP_ID || null,
            agentId: AGENT_ID || null,
          },
        }),
      // The runner connection also CARRIES the permission request→response
      // (Pillar 1, Phase 5.3d) via permission-callback.ts, which sends over this
      // SAME client. A signed permission resp is verified fail-closed here with
      // the runner's ed25519 response-verify key.
      verifyResponse: (p, sig) =>
        verifyIpcResponsePayload(IPC_RESPONSE_VERIFY_KEY, p, sig),
      onPush: (frame) => {
        const { closed } = routeRunnerPushFrame(frame, {
          onContinuation: (text) => {
            if (!enableIpcFollowups) return;
            const delivery = steeringGate.accept(text);
            if (delivery === 'buffered') {
              log(
                `Buffering IPC message until query turn boundary (${text.length} chars)`,
              );
            }
          },
          onClose: closeQueryStream,
        });
        if (closed) {
          setActiveRunnerSocketClient(undefined);
          ipcSocketClient?.close();
          ipcSocketClient = undefined;
        }
      },
      reconnect: {
        enabled: true,
        replayPending: true,
      },
    });
    // Publish the run's runner client so the permission callback sends its
    // request over this SAME connection (one runner connection per run). It is
    // published before connect() resolves; the callback only uses it when
    // `connected` is true and otherwise denies boundedly.
    setActiveRunnerSocketClient(ipcSocketClient);
  }
  const emitInteractionBoundary = () => {
    writeOutput({
      status: 'success',
      result: null,
      newSessionId,
      interactionBoundary: 'user_interaction',
    });
  };
  let lastAssistantUuid: string | undefined;
  let firstSdkMessageAt: number | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let sawPartialTextSinceLastResult = false;
  let pendingPartialText = '';
  let pendingPartialStopReason: string | undefined;
  const primeToolAttempts: AgentRunnerToolAttemptOutput[] = [];
  let pendingCachePrewarmTrace: WarmCachePrewarmTrace | undefined;
  // Per-turn LLM latency + token capture for the reply trace (best-effort).
  // Payloads (input/output text) only when GANTRY_TRACE_PAYLOADS=1.
  const capturePayloads = process.env['GANTRY_TRACE_PAYLOADS']?.trim() === '1';
  const llmTurns = new LlmTurnAccumulator({ capturePayloads });
  const sdkToolCalls = new SdkToolCallAccumulator(capturePayloads);
  const heartbeat = startJobHeartbeat({
    agentInput,
    writeOutput,
    getSessionId: () => newSessionId,
  });
  const externalMcpServers = readExternalMcpServers();
  const externalMcpAllowedTools = readExternalMcpAllowedTools();
  const externalMcpAlwaysAllowedTools = readExternalMcpAlwaysAllowedTools();
  const approvedMcpServerNames = [
    ...Object.keys(externalMcpServers),
    ...(agentInput.attachedMcpSourceIds ?? []).map((id) =>
      id.startsWith('mcp:') ? id.slice(4) : id,
    ),
  ];
  const enabledSdkSkills = readClaudeSdkSkillNamesFromEnv();
  const progressiveSdkSkills = readClaudeSdkProgressiveSkillNamesFromEnv();
  const systemPrompt = buildRunnerSystemPrompt(
    agentInput,
    memoryBlock,
    {
      approvedMcpServerNames,
      mcpListToolsEnabled: externalMcpAllowedTools.includes(
        'mcp__gantry__mcp_list_tools',
      ),
    },
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
    ipcSocketPath: process.env.GANTRY_IPC_SOCKET_PATH,
    boundIdentityFile: process.env.GANTRY_BOUND_IDENTITY_FILE,
    browserIpcAuthToken: process.env.GANTRY_BROWSER_IPC_AUTH_TOKEN,
    memoryIpcAuthToken: process.env.GANTRY_MEMORY_IPC_AUTH_TOKEN,
    ipcResponseVerifyKey: process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY,
    ipcResponseKeyId: process.env.GANTRY_IPC_RESPONSE_KEY_ID,
    externalMcpServers,
    externalMcpAllowedTools,
    externalMcpAlwaysAllowedTools,
    isScheduledJob: agentInput.isScheduledJob,
  });
  if (ipcSocketClient) {
    try {
      await ipcSocketClient.connect();
      log('Runner IPC socket connected (continuation/close fast-path)');
    } catch (err) {
      log(
        `Runner IPC socket connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const sdkOptions: Options = {
    model: configuredModel,
    thinking: queryThinking,
    effort: queryEffort,
    cwd: WORKSPACE_GROUP_DIR,
    additionalDirectories:
      additionalDirectories.length > 0 ? additionalDirectories : undefined,
    persistSession: persistSdkSession,
    systemPrompt,
    settings: {
      autoMemoryEnabled: false,
      includeGitInstructions: includeGitInstructionsForPersona(
        agentInput.persona,
      ),
      skillOverrides: SDK_NATIVE_SKILL_OVERRIDES,
    },
    skills: enabledSdkSkills,
    tools: claudeSdkToolsForEnabledSkills(
      capabilities.availableTools,
      enabledSdkSkills,
      progressiveSdkSkills,
    ),
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
    settingSources: ['user'],
    mcpServers: capabilities.mcpServers,
    includePartialMessages: true,
    ...(process.env.GANTRY_CLAUDE_SDK_DEBUG_FILE?.trim()
      ? { debugFile: process.env.GANTRY_CLAUDE_SDK_DEBUG_FILE.trim() }
      : {}),
  };
  // MEASUREMENT-ONLY: just before the SDK spawns the Claude Code CLI subprocess.
  timingMark('before_sdk_query');
  const queryDispatchedAt = Date.now();
  const warmQueryResult = warmGenericBoot
    ? await dispatchWarmQuery({
        sdkOptions,
        stream,
        guardrailPreface: agentInput.guardrailSystemPromptAppend,
        captureCachePrewarmPayloads: capturePayloads,
        onBound: (scope) => {
          warmBound = true;
          boundChatJid = scope.chatJid;
          pendingTurnInput = scope.firstMessage;
          pendingTurnDispatchedAt = Date.now();
        },
      })
    : undefined;
  pendingCachePrewarmTrace = warmQueryResult?.cachePrewarmTrace;
  const sdkQueryArgs = { prompt: stream, options: sdkOptions };
  const effectivePrompt =
    warmQueryResult?.effectiveFirstMessage ?? pendingTurnInput;
  const sdkQueryArgsPayload = {
    capturedAt: new Date().toISOString(),
    path: warmQueryResult?.query ? 'warm_bound_worker' : 'cold_query',
    prompt: effectivePrompt,
    ...(effectivePrompt !== pendingTurnInput
      ? { rawPrompt: pendingTurnInput }
      : {}),
    options: sdkOptions,
  };
  log(
    `[LLM_SDK_QUERY_ARGS] ${JSON.stringify({
      path: warmQueryResult?.query ? 'warm_bound_worker' : 'cold_query',
      prompt: pendingTurnInput,
      options: sdkOptions,
    })}`,
  );
  const rootPayloadLogPath =
    process.env.GANTRY_LLM_PAYLOAD_JSON ||
    `${process.cwd()}/llm-sdk-query-args.json`;
  writeSdkQueryArgsPayloadLogs({
    latestPath: rootPayloadLogPath,
    historyPath:
      process.env.GANTRY_LLM_PAYLOAD_LOG ||
      '/tmp/gantry-llm-sdk-query-args.jsonl',
    payload: sdkQueryArgsPayload,
  });
  const sdkQuery = warmQueryResult?.query ?? query(sdkQueryArgs);
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
        const assistantReceivedAt = Date.now();
        const assistantText = assistantOutputText(message);
        // Per-turn latency/usage capture (best-effort). Wall-clock Date.now()
        // is comparable with the core MCP-call timestamps on this single host,
        // so stages merge by start time across the child/core boundary.
        llmTurns.onAssistant(
          message as Parameters<typeof llmTurns.onAssistant>[0],
          assistantReceivedAt,
          capturePayloads
            ? {
                output: assistantText,
                // The driving message (run prompt, or the warm-run continuation
                // just piped in) belongs to the turn that answers it; tool-loop
                // follow-ons of the same message carry no fresh input.
                ...(pendingTurnInput !== undefined
                  ? { input: pendingTurnInput }
                  : {}),
              }
            : undefined,
        );
        sdkToolCalls.onAssistant(message, assistantReceivedAt);
        pendingTurnInput = undefined;
        if (messageContainsToolUse(message)) {
          // Surface this turn's preamble ("let me look that up…") as an early
          // progress message. The text and tool_use can arrive split across two
          // assistant messages, so fall back to the streamed text when this
          // tool_use message has none of its own (see selectToolUsePreamble).
          const preamble = selectToolUsePreamble(
            assistantText,
            pendingPartialText,
          );
          if (preamble.trim()) {
            writeOutput({
              status: 'success',
              result: preamble,
              llmTurnOutput: { stopReason: 'tool_use' },
              newSessionId,
            });
          }
          pendingPartialText = '';
          pendingPartialStopReason = undefined;
        }
      }
      if (message.type === 'user') {
        sdkToolCalls.onUser(message, Date.now());
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
                  chatJid: boundChatJid ?? agentInput.chatJid,
                  threadId: agentInput.threadId,
                },
                rateLimit,
                newSessionId,
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
          const stopReason =
            typeof event.delta?.stop_reason === 'string'
              ? event.delta.stop_reason
              : undefined;
          pendingPartialStopReason = stopReason;
          llmTurns.onFinalUsage(event.usage, event.delta?.stop_reason);
          if (
            stopReason &&
            stopReason !== 'end_turn' &&
            pendingPartialText.trim()
          ) {
            writeOutput({
              status: 'success',
              result: pendingPartialText,
              llmTurnOutput: { stopReason },
              newSessionId,
            });
            pendingPartialText = '';
            pendingPartialStopReason = undefined;
          }
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
        const toolCalls = sdkToolCalls.calls();
        const continuedByFollowup = steeringGate.pendingCount() > 0;
        if (pendingPartialText) {
          writeOutput({
            status: 'success',
            result: pendingPartialText,
            llmTurnOutput: { stopReason: pendingPartialStopReason },
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
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(warmBound ? { warmBound: true } : {}),
          ...(pendingCachePrewarmTrace
            ? { cachePrewarmTrace: pendingCachePrewarmTrace }
            : {}),
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
                  newSessionId,
                  resultCount,
                  queryRunId,
                ),
              }
            : {}),
        });
        pendingCachePrewarmTrace = undefined;
        contextUsageEmitter.emitAfterResult();
        sawPartialTextSinceLastResult = false;
        pendingPartialText = '';
        pendingPartialStopReason = undefined;
        steeringGate.markTurnBoundary();
      }
    }
  } finally {
    heartbeat.stop();
    steeringGate.close();
    // Unpublish before close so a late permission callback never sends over a
    // closing connection.
    setActiveRunnerSocketClient(undefined);
    ipcSocketClient?.close();
    ipcSocketClient = undefined;
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
