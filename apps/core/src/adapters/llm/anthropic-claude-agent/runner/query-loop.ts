import {
  query,
  type EffortLevel,
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
  const stream = new MessageStream();
  const queryRunId = randomUUID();
  const memoryBlock = readMemoryContextBlock(agentInput);
  stream.pushInitialPrompt(prompt, memoryBlock);
  if (!enableIpcFollowups) {
    stream.end();
  }
  let ipcPolling = true;
  let closedDuringQuery = false;
  let newSessionId: string | undefined;
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
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;
  let sawPartialTextSinceLastResult = false;
  let pendingPartialText = '';
  const primeToolAttempts: AgentRunnerToolAttemptOutput[] = [];
  // Per-turn LLM latency + token capture for the reply trace (best-effort).
  // Payloads (input/output text) only when GANTRY_TRACE_PAYLOADS=1.
  const llmTurns = new LlmTurnAccumulator({
    capturePayloads: process.env['GANTRY_TRACE_PAYLOADS']?.trim() === '1',
  });
  const heartbeat = startJobHeartbeat({
    agentInput,
    writeOutput,
    getSessionId: () => newSessionId,
  });
  const externalMcpServers = readExternalMcpServers();
  const externalMcpAllowedTools = readExternalMcpAllowedTools();
  const externalMcpAlwaysAllowedTools = readExternalMcpAlwaysAllowedTools();
  const systemPrompt = buildRunnerSystemPrompt(agentInput, memoryBlock, {
    approvedMcpServerNames: Object.keys(externalMcpServers),
  });
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
  // MEASUREMENT-ONLY: just before the SDK spawns the Claude Code CLI subprocess.
  timingMark('before_sdk_query');
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
        recordToolActivity: (toolName) =>
          heartbeat.recordToolActivity(toolName),
      }),
      settingSources: ['user'],
      mcpServers: capabilities.mcpServers,
      includePartialMessages: true,
    },
  });
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
      if (messageCount === 1) timingMark('first_sdk_message');
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
        );
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
                  chatJid: agentInput.chatJid,
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
              delta?: { type?: string; text?: string };
            }
          | undefined;
        if (event?.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            sawPartialTextSinceLastResult = true;
            pendingPartialText += delta.text;
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
