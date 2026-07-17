import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { ConversationRoute } from '../domain/types.js';
import type { MaterializedMcpServer } from '../domain/mcp/mcp-servers.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import {
  McpServerService,
  type MaterializedMcpCapability,
} from '../application/mcp/mcp-server-service.js';
import { resolveMcpCredentialEnvForAgent } from '../application/capability-secrets/mcp-secret-projection.js';
import { logger } from '../infrastructure/logging/logger.js';
import { ensurePrivateDirSync } from '../shared/private-fs.js';
import { formatDuration } from '../shared/human-format.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { mcpToolPatternCovers } from '../shared/mcp-tool-scope.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import {
  getHostRuntimeCredentialEnv,
  prepareInlineAgentHostContext,
} from './agent-spawn-host.js';
import { validateAgentPreSpawnAdmission } from './agent-spawn-admission.js';
import { ensureWorkspaceIpcLayout } from './agent-spawn-layout.js';
import { resolveSpawnModel } from './agent-spawn-model-resolution.js';
import type {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
} from './agent-spawn-types.js';
import {
  outputWithProviderSession,
  providerSessionExternalSessionId,
} from './agent-output-provider-session.js';
import { abortedRunnerOutput } from './agent-spawn-process-abort.js';
import {
  formatScheduledJobIdleStallError,
  readScheduledJobHeartbeat,
  scheduledJobIdleTimeoutMs,
  type ScheduledJobHeartbeatPayload,
} from './agent-spawn-scheduled-idle.js';
import {
  RUNNER_CONTROL_PORT,
  type ContinuationRunnerControlPort,
} from './group-queue-types.js';
import { activeRunStopWasRequested } from './group-queue-stop.js';
import type { RunnerControlContinuationInput } from './runner-control-port.js';

export const INLINE_AGENT_LOOP_NOT_AVAILABLE =
  'INLINE_AGENT_LOOP_NOT_AVAILABLE';
export const INLINE_JOB_HEARTBEAT_INTERVAL_MS = 15_000;

interface InlineControlSubscriber {
  onContinuation(input: RunnerControlContinuationInput): void;
  onClose(): void;
}

export class InMemoryInlineRunnerControlPort implements ContinuationRunnerControlPort {
  private readonly subscribers = new Set<InlineControlSubscriber>();
  private pendingContinuations: RunnerControlContinuationInput[] = [];
  private closeRequested = false;

  subscribe(subscriber: InlineControlSubscriber): () => void {
    this.subscribers.add(subscriber);
    for (const continuation of this.pendingContinuations.splice(0)) {
      subscriber.onContinuation(continuation);
    }
    if (this.closeRequested) subscriber.onClose();
    return () => this.subscribers.delete(subscriber);
  }

  writeContinuationInput(input: RunnerControlContinuationInput): void {
    if (this.subscribers.size === 0) {
      this.pendingContinuations.push(input);
      return;
    }
    for (const subscriber of this.subscribers) {
      subscriber.onContinuation(input);
    }
  }

  writeCloseSignal(): void {
    this.closeRequested = true;
    for (const subscriber of this.subscribers) subscriber.onClose();
  }
}

export interface InlineJobActivity {
  beginPermissionRequest(requestId: string, toolName: string): void;
  finishPermissionRequest(requestId: string): void;
}

export interface InlineAgentLoopLaneInput {
  group: ConversationRoute;
  input: AgentInput & {
    compiledSystemPrompt: string;
    permissionMode: PermissionMode;
  };
  signal: AbortSignal;
  controlPort: InMemoryInlineRunnerControlPort;
  resolvedModel: Awaited<ReturnType<typeof resolveSpawnModel>>['resolvedModel'];
  modelCredentialEnv: Readonly<Record<string, string>>;
  mcpServers: readonly MaterializedMcpCapability[];
  mcpHostnameLookup?: HostnameLookup;
  skillRepository?: RunAgentOptions['skillRepository'];
  skillArtifactStore?: RunAgentOptions['skillArtifactStore'];
  skillContext?: RunAgentOptions['skillContext'];
  runtimeDataDir: string;
  maxTurns?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  configuredThinking?: import('../domain/types.js').AgentControlThinking;
  maxOutputTokens?: number;
  jobActivity: InlineJobActivity;
  emitOutput(output: AgentOutput): Promise<void>;
}

export type InlineAgentLoopLane = (
  input: InlineAgentLoopLaneInput,
) => Promise<AgentOutput>;

export interface InlineRunAgentOptions extends RunAgentOptions {
  inlineAgentLoopLane?: InlineAgentLoopLane;
}

let defaultInlineAgentLoopLane: InlineAgentLoopLane | undefined;

export function configureDefaultInlineAgentLoopLane(
  lane: InlineAgentLoopLane | undefined,
): void {
  defaultInlineAgentLoopLane = lane;
}

/**
 * Follow-up loop-lane work replaces this seam, not the execution shell.
 * Implementations must observe signal.abort; the run remains active until the
 * lane settles so cancellation cannot leave hidden in-process work behind.
 */
export async function runInlineAgentLoopLane(
  input: InlineAgentLoopLaneInput,
): Promise<AgentOutput> {
  if (defaultInlineAgentLoopLane) return defaultInlineAgentLoopLane(input);
  return {
    status: 'error',
    result: null,
    error: `${INLINE_AGENT_LOOP_NOT_AVAILABLE}: Inline agent loop lanes are not available in this build.`,
  };
}

export function createInlineRunHandle(
  controller: AbortController,
  controlPort = new InMemoryInlineRunnerControlPort(),
): ChildProcess {
  const handle = {
    pid: undefined,
    killed: false,
    kill() {
      if (handle.killed) return false;
      handle.killed = true;
      controller.abort();
      return true;
    },
    [RUNNER_CONTROL_PORT]: controlPort,
  };
  return handle as unknown as ChildProcess;
}

export async function runInlineAgent(
  group: ConversationRoute,
  input: AgentInput,
  onProcess: (proc: ChildProcess, runHandle: string) => void,
  onOutput: ((output: AgentOutput) => Promise<void>) | undefined,
  options: InlineRunAgentOptions,
): Promise<AgentOutput> {
  if (!isValidWorkspaceFolder(group.folder)) {
    return inlineFailure(
      'Inline agent setup failed',
      new Error(`Invalid workspace folder "${group.folder}"`),
    );
  }
  let hostContext: Awaited<ReturnType<typeof prepareInlineAgentHostContext>>;
  let mcpSourceRecords: MaterializedMcpServer[];
  try {
    hostContext = await prepareInlineAgentHostContext(group, input);
    mcpSourceRecords = await listInlineMcpSourceRecords(input, options);
  } catch (error) {
    return inlineFailure('Inline agent setup failed', error);
  }
  const { resolvedModel } = hostContext;
  if (!resolvedModel.ok) {
    return { status: 'error', result: null, error: resolvedModel.message };
  }

  const admissionError = validateAgentPreSpawnAdmission({
    agentInput: {
      ...input,
      effort: hostContext.effort,
      configuredThinking: hostContext.configuredThinking,
      maxOutputTokens: hostContext.maxOutputTokens,
    },
    agentEngine: resolvedModel.value.agentEngine,
    modelEntry: resolvedModel.value.modelEntry,
    agentRuntime: 'inline',
    stdioMcpSourceIds: mcpSourceRecords
      .filter(({ definition }) => definition.transport === 'stdio_template')
      .map(({ definition }) => definition.id),
    securityEnv: process.env,
    sandboxProvider: hostContext.sandboxProvider,
  });
  if (admissionError) {
    return { status: 'error', result: null, error: admissionError };
  }
  const sessionsLogDir = path.join(
    hostContext.dataDir,
    'sessions',
    group.folder,
    'logs',
  );
  ensurePrivateDirSync(sessionsLogDir);
  ensureWorkspaceIpcLayout(
    path.join(hostContext.dataDir, 'ipc', group.folder),
    'inline',
  );

  if (options.signal?.aborted) return abortedRunnerOutput('Inline agent');
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  let credentials: Awaited<ReturnType<typeof getHostRuntimeCredentialEnv>>;
  try {
    credentials = await getHostRuntimeCredentialEnv(
      group.folder.toLowerCase().replace(/_/g, '-'),
      options.credentialBroker,
      {
        purpose: 'model_runtime',
        runId: options.correlationRunId as never,
        runContext: input,
        modelRouteId: resolvedModel.value.modelEntry.modelRoute.id,
      },
    );
  } catch (error) {
    options.signal?.removeEventListener('abort', abortFromCaller);
    return inlineFailure('Inline agent setup failed', error);
  }

  try {
    const mcpServers = await materializeInlineMcpServers(
      input,
      options,
      mcpSourceRecords,
    );
    return await executeInlineRun({
      group,
      input: {
        ...input,
        compiledSystemPrompt: hostContext.compiledSystemPrompt ?? '',
        permissionMode: hostContext.permissionMode,
        ...(hostContext.toolRules ? { toolRules: hostContext.toolRules } : {}),
      },
      onProcess,
      onOutput,
      options,
      controller,
      credentials,
      mcpServers,
      resolvedModel,
      defaultTimeoutMs: hostContext.defaultTimeoutMs,
      idleTimeoutMs: hostContext.idleTimeoutMs,
      runtimeDataDir: hostContext.dataDir,
      maxTurns: hostContext.maxTurns,
      effort: hostContext.effort,
      configuredThinking: hostContext.configuredThinking,
      maxOutputTokens: hostContext.maxOutputTokens,
    });
  } catch (error) {
    return inlineFailure('Inline agent setup failed', error);
  } finally {
    options.signal?.removeEventListener('abort', abortFromCaller);
    await credentials.revoke?.().catch((error) => {
      logger.warn(
        { error, group: group.name },
        'Failed to revoke inline agent model gateway token',
      );
    });
  }
}

async function executeInlineRun(input: {
  group: ConversationRoute;
  input: AgentInput & {
    compiledSystemPrompt: string;
    permissionMode: PermissionMode;
  };
  onProcess: (proc: ChildProcess, runHandle: string) => void;
  onOutput?: (output: AgentOutput) => Promise<void>;
  options: InlineRunAgentOptions;
  controller: AbortController;
  credentials: Awaited<ReturnType<typeof getHostRuntimeCredentialEnv>>;
  mcpServers: readonly MaterializedMcpCapability[];
  resolvedModel: Awaited<ReturnType<typeof resolveSpawnModel>>['resolvedModel'];
  defaultTimeoutMs: number;
  idleTimeoutMs: number;
  runtimeDataDir: string;
  maxTurns?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  configuredThinking?: import('../domain/types.js').AgentControlThinking;
  maxOutputTokens?: number;
}): Promise<AgentOutput> {
  const controlPort = new InMemoryInlineRunnerControlPort();
  const handle = createInlineRunHandle(input.controller, controlPort);
  const runHandle = `gantry-inline-${input.group.folder}-${currentTimeMs()}-${randomUUID().slice(0, 8)}`;
  let providerSessionId: string | undefined;
  let active = true;
  let lastActivityAtMs = currentTimeMs();
  let lastTool: string | undefined;
  let totalToolCalls = 0;
  const pendingPermissionTools = new Map<string, string>();
  const recordToolActivity = (toolName: string) => {
    lastTool = toolName;
    totalToolCalls += 1;
    lastActivityAtMs = currentTimeMs();
  };
  const jobActivity: InlineJobActivity = {
    beginPermissionRequest(requestId, toolName) {
      pendingPermissionTools.set(requestId, toolName);
      lastActivityAtMs = currentTimeMs();
    },
    finishPermissionRequest(requestId) {
      pendingPermissionTools.delete(requestId);
      lastActivityAtMs = currentTimeMs();
    },
  };
  let outputChain = Promise.resolve();
  let resetTimeout = () => undefined;
  const deliverOutput = async (output: AgentOutput, marksActivity: boolean) => {
    if (!active) return;
    resetTimeout();
    if (marksActivity) lastActivityAtMs = currentTimeMs();
    for (const event of output.runtimeEvents ?? []) {
      if (event.eventType !== RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY) continue;
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.phase !== 'started') continue;
      if (typeof payload.tool === 'string') {
        recordToolActivity(payload.tool);
      }
    }
    providerSessionId =
      providerSessionExternalSessionId(output) ?? providerSessionId;
    const normalized = outputWithProviderSession(output, providerSessionId);
    outputChain = outputChain.then(async () => {
      try {
        await input.onOutput?.(normalized);
      } catch (error) {
        logger.error(
          { error, group: input.group.name },
          'Inline agent output callback failed',
        );
      }
    });
    await outputChain;
  };
  const emitOutput = (output: AgentOutput) => deliverOutput(output, true);

  input.onProcess(handle, runHandle);
  if (input.controller.signal.aborted) {
    return abortedRunnerOutput('Inline agent', providerSessionId);
  }
  let timedOut = false;
  const configuredTimeoutMs =
    input.options.timeoutMs ??
    input.group.agentConfig?.timeout ??
    input.defaultTimeoutMs;
  const hasExplicitTimeout = input.options.timeoutMs != null;
  const timeoutMs = hasExplicitTimeout
    ? configuredTimeoutMs
    : Math.max(configuredTimeoutMs, input.idleTimeoutMs + 30_000);
  const armTimeout = () => {
    const timer = setTimeout(() => {
      timedOut = true;
      input.controller.abort();
    }, timeoutMs);
    timer.unref?.();
    return timer;
  };
  let timeout = armTimeout();
  resetTimeout = () => {
    if (hasExplicitTimeout && !input.input.isScheduledJob) return;
    clearTimeout(timeout);
    timeout = armTimeout();
  };
  const scheduledIdleMs = scheduledJobIdleTimeoutMs();
  let scheduledIdleStall: ScheduledJobHeartbeatPayload | undefined;
  const heartbeat = input.input.isScheduledJob
    ? async () => {
        const output = inlineHeartbeat(input.input, lastActivityAtMs, {
          lastTool,
          pendingPermissionToolNames: [...pendingPermissionTools.values()],
          totalToolCalls,
        });
        const payload = readScheduledJobHeartbeat(output) ?? undefined;
        await deliverOutput(output, false);
        if (
          payload &&
          (payload.pendingPermissionRequests ?? 0) === 0 &&
          (payload.lastActivityAgoMs ?? 0) >= scheduledIdleMs
        ) {
          scheduledIdleStall = payload;
          input.controller.abort();
        }
      }
    : undefined;
  if (heartbeat) await heartbeat();
  const heartbeatTimer = heartbeat
    ? setInterval(() => void heartbeat(), INLINE_JOB_HEARTBEAT_INTERVAL_MS)
    : undefined;
  heartbeatTimer?.unref?.();

  const aborted = new Promise<{ kind: 'aborted'; output: AgentOutput }>(
    (resolve) => {
      const settle = () =>
        resolve({
          kind: 'aborted',
          output: scheduledIdleStall
            ? {
                status: 'error',
                result: null,
                error: formatScheduledJobIdleStallError({
                  timeoutMs: scheduledIdleMs,
                  heartbeat: scheduledIdleStall,
                }),
              }
            : timedOut
              ? {
                  status: 'error',
                  result: null,
                  error: `Inline agent timed out after ${formatDuration(timeoutMs)}`,
                }
              : activeRunStopWasRequested(handle)
                ? {
                    status: 'error',
                    result: null,
                    error: 'Inline agent stopped by request',
                  }
                : abortedRunnerOutput('Inline agent', providerSessionId),
        });
      if (input.controller.signal.aborted) settle();
      else
        input.controller.signal.addEventListener('abort', settle, {
          once: true,
        });
    },
  );
  const lane = input.options.inlineAgentLoopLane ?? runInlineAgentLoopLane;
  const laneResult = Promise.resolve()
    .then(() =>
      lane({
        group: input.group,
        input: input.input,
        signal: input.controller.signal,
        controlPort,
        resolvedModel: input.resolvedModel,
        modelCredentialEnv: input.credentials.env,
        mcpServers: input.mcpServers,
        mcpHostnameLookup: input.options.mcpHostnameLookup,
        skillRepository: input.options.skillRepository,
        skillArtifactStore: input.options.skillArtifactStore,
        skillContext: input.options.skillContext,
        runtimeDataDir: input.runtimeDataDir,
        maxTurns: input.maxTurns,
        effort: input.effort,
        configuredThinking: input.configuredThinking,
        maxOutputTokens: input.maxOutputTokens,
        jobActivity,
        emitOutput,
      }),
    )
    .catch((error) => inlineFailure('Inline agent loop failed', error));
  const settledLane = laneResult.then((output) => ({
    kind: 'lane' as const,
    output,
  }));

  try {
    const first = await Promise.race([settledLane, aborted]);
    if (first.kind === 'aborted') await settledLane;
    await outputChain;
    return outputWithProviderSession(first.output, providerSessionId);
  } finally {
    active = false;
    clearTimeout(timeout);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

async function listInlineMcpSourceRecords(
  input: AgentInput,
  options: InlineRunAgentOptions,
): Promise<MaterializedMcpServer[]> {
  const serverIds = input.attachedMcpSourceIds ?? [];
  if (
    serverIds.length === 0 ||
    !options.mcpServerRepository ||
    !options.mcpContext?.appId ||
    !options.mcpContext.agentId
  ) {
    return [];
  }
  return options.mcpServerRepository.listMaterializedServersForAgent({
    appId: options.mcpContext.appId as never,
    agentId: options.mcpContext.agentId as never,
    serverIds: serverIds as never,
  });
}

async function materializeInlineMcpServers(
  input: AgentInput,
  options: InlineRunAgentOptions,
  records: readonly MaterializedMcpServer[],
): Promise<MaterializedMcpCapability[]> {
  if (
    records.length === 0 ||
    !options.mcpServerRepository ||
    !options.mcpContext?.appId ||
    !options.mcpContext.agentId
  ) {
    return [];
  }
  const serverIds = records
    .filter(
      ({ definition }) =>
        (definition.transport === 'http' || definition.transport === 'sse') &&
        inlineMcpToolAuthority(input, definition.name).length > 0,
    )
    .map(({ definition }) => definition.id);
  if (serverIds.length === 0) return [];
  const credentialEnv = options.capabilitySecretRepository
    ? await resolveMcpCredentialEnvForAgent({
        appId: options.mcpContext.appId as never,
        agentId: options.mcpContext.agentId as never,
        serverIds,
        mcpServers: options.mcpServerRepository,
        secrets: options.capabilitySecretRepository,
      })
    : {};
  const capabilities = await new McpServerService(
    options.mcpServerRepository,
    undefined,
    {
      lookupHostname: options.mcpHostnameLookup,
      dnsValidationCache: options.mcpDnsValidationCache,
    },
  ).materializeForAgent({
    appId: options.mcpContext.appId as never,
    agentId: options.mcpContext.agentId as never,
    serverIds,
    credentialEnv,
  });
  return capabilities.flatMap((capability) => {
    const allowedToolNames = intersectInlineMcpToolScopes(
      capability.name,
      inlineMcpToolAuthority(input, capability.name),
      capability.allowedToolNames,
    );
    if (allowedToolNames.length === 0) return [];
    const prefix = `mcp__${capability.name}__`;
    const autoApproveToolNames = intersectInlineMcpToolScopes(
      capability.name,
      allowedToolNames,
      capability.autoApproveToolNames,
    );
    return [
      {
        ...capability,
        allowedToolNames,
        allowedToolPatterns: allowedToolNames.map((toolName) =>
          toolName.slice(prefix.length),
        ),
        autoApproveToolNames,
        autoApproveToolPatterns: autoApproveToolNames.map((toolName) =>
          toolName.slice(prefix.length),
        ),
      },
    ];
  });
}

function inlineMcpToolAuthority(
  input: AgentInput,
  serverName: string,
): string[] {
  const prefix = `mcp__${serverName}__`;
  return (input.runtimeAccess ?? []).flatMap((access) =>
    access.sourceType === 'mcp_server'
      ? access.allowedTools.filter((tool) => tool.startsWith(prefix))
      : [],
  );
}

function intersectInlineMcpToolScopes(
  serverName: string,
  authority: readonly string[],
  sourceScope: readonly string[],
): string[] {
  const prefix = `mcp__${serverName}__`;
  const patterns = new Set<string>();
  for (const authorityTool of authority) {
    if (!authorityTool.startsWith(prefix)) continue;
    const authorityPattern = authorityTool.slice(prefix.length);
    if (!authorityPattern) continue;
    for (const sourceTool of sourceScope) {
      if (!sourceTool.startsWith(prefix)) continue;
      const sourcePattern = sourceTool.slice(prefix.length);
      if (!sourcePattern) continue;
      if (mcpToolPatternCovers(authorityPattern, sourcePattern)) {
        patterns.add(sourcePattern);
      } else if (mcpToolPatternCovers(sourcePattern, authorityPattern)) {
        patterns.add(authorityPattern);
      }
    }
  }
  return [...patterns].map((pattern) => `${prefix}${pattern}`);
}

function inlineHeartbeat(
  input: AgentInput,
  lastActivityAtMs: number,
  activity: {
    lastTool?: string;
    pendingPermissionToolNames: readonly string[];
    totalToolCalls: number;
  },
): AgentOutput {
  const emittedAtMs = currentTimeMs();
  return {
    status: 'success',
    result: null,
    runtimeEventOnly: true,
    runtimeEvents: [
      {
        appId: input.appId,
        agentId: input.agentId,
        runId: input.runId,
        jobId: input.jobId,
        conversationId: input.chatJid,
        threadId: input.threadId,
        eventType: RUNTIME_EVENT_TYPES.JOB_HEARTBEAT,
        actor: 'runner',
        responseMode: 'none',
        payload: {
          ...(activity.lastTool ? { lastTool: activity.lastTool } : {}),
          lastActivityAt: new Date(lastActivityAtMs).toISOString(),
          lastActivityAgoMs: Math.max(0, emittedAtMs - lastActivityAtMs),
          pendingPermissionRequests: activity.pendingPermissionToolNames.length,
          pendingPermissionToolNames: [
            ...new Set(activity.pendingPermissionToolNames),
          ],
          totalToolCalls: activity.totalToolCalls,
        },
      },
    ],
  };
}

function inlineFailure(prefix: string, error: unknown): AgentOutput {
  return {
    status: 'error',
    result: null,
    error: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
  };
}
