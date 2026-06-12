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
  IPC_POLL_MS,
  resolveClaudeCodeExecutableFromPath,
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
    runId: agentInput.runId,
    runLeaseToken: agentInput.runLeaseToken,
    runLeaseFencingVersion: agentInput.runLeaseFencingVersion,
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
  log(
    `SDK query prepared in ${elapsedMs()}ms ` +
      `(tools=${capabilities.availableTools.length} mcpServers=${Object.keys(capabilities.mcpServers ?? {}).length})`,
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
            ],
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
  log(`SDK query iterator created in ${elapsedMs()}ms`);
  try {
    let firstSdkMessageLogged = false;
    let firstTextDeltaLogged = false;
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
        log(`First SDK message after ${elapsedMs()}ms`);
      }
      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        assertRequiredMcpServerReady(message);
        log(
          `Session initialized after ${elapsedMs()}ms: provider resume handle received`,
        );
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
              log(`First SDK text delta after ${elapsedMs()}ms`);
            }
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
        if (resultCount === 1) {
          log(`First SDK result after ${elapsedMs()}ms`);
        }
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
