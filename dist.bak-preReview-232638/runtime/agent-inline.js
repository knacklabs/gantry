import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { McpServerService, } from '../application/mcp/mcp-server-service.js';
import { resolveMcpCredentialEnvForAgent } from '../application/capability-secrets/mcp-secret-projection.js';
import { logger } from '../infrastructure/logging/logger.js';
import { ensurePrivateDirSync } from '../shared/private-fs.js';
import { formatDuration } from '../shared/human-format.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { mcpToolPatternCovers } from '../shared/mcp-tool-scope.js';
import { getHostRuntimeCredentialEnv, prepareInlineAgentHostContext, } from './agent-spawn-host.js';
import { validateAgentPreSpawnAdmission } from './agent-spawn-admission.js';
import { ensureWorkspaceIpcLayout } from './agent-spawn-layout.js';
import { outputWithProviderSession, providerSessionExternalSessionId, } from './agent-output-provider-session.js';
import { abortedRunnerOutput } from './agent-spawn-process-abort.js';
import { formatScheduledJobIdleStallError, readScheduledJobHeartbeat, scheduledJobIdleTimeoutMs, } from './agent-spawn-scheduled-idle.js';
import { RUNNER_CONTROL_PORT, } from './group-queue-types.js';
import { activeRunStopWasRequested } from './group-queue-stop.js';
export const INLINE_AGENT_LOOP_NOT_AVAILABLE = 'INLINE_AGENT_LOOP_NOT_AVAILABLE';
export const INLINE_JOB_HEARTBEAT_INTERVAL_MS = 15_000;
export class InMemoryInlineRunnerControlPort {
    subscribers = new Set();
    pendingContinuations = [];
    closeRequested = false;
    subscribe(subscriber) {
        this.subscribers.add(subscriber);
        for (const continuation of this.pendingContinuations.splice(0)) {
            subscriber.onContinuation(continuation);
        }
        if (this.closeRequested)
            subscriber.onClose();
        return () => this.subscribers.delete(subscriber);
    }
    writeContinuationInput(input) {
        if (this.subscribers.size === 0) {
            this.pendingContinuations.push(input);
            return;
        }
        for (const subscriber of this.subscribers) {
            subscriber.onContinuation(input);
        }
    }
    writeCloseSignal() {
        this.closeRequested = true;
        for (const subscriber of this.subscribers)
            subscriber.onClose();
    }
}
let defaultInlineAgentLoopLane;
export function configureDefaultInlineAgentLoopLane(lane) {
    defaultInlineAgentLoopLane = lane;
}
/**
 * Follow-up loop-lane work replaces this seam, not the execution shell.
 * Implementations must observe signal.abort; the run remains active until the
 * lane settles so cancellation cannot leave hidden in-process work behind.
 */
export async function runInlineAgentLoopLane(input) {
    if (defaultInlineAgentLoopLane)
        return defaultInlineAgentLoopLane(input);
    return {
        status: 'error',
        result: null,
        error: `${INLINE_AGENT_LOOP_NOT_AVAILABLE}: Inline agent loop lanes are not available in this build.`,
    };
}
export function createInlineRunHandle(controller, controlPort = new InMemoryInlineRunnerControlPort()) {
    const handle = {
        pid: undefined,
        killed: false,
        kill() {
            if (handle.killed)
                return false;
            handle.killed = true;
            controller.abort();
            return true;
        },
        [RUNNER_CONTROL_PORT]: controlPort,
    };
    return handle;
}
export async function runInlineAgent(group, input, onProcess, onOutput, options) {
    if (!isValidWorkspaceFolder(group.folder)) {
        return inlineFailure('Inline agent setup failed', new Error(`Invalid workspace folder "${group.folder}"`));
    }
    let hostContext;
    let mcpSourceRecords;
    try {
        hostContext = await prepareInlineAgentHostContext(group, input);
        mcpSourceRecords = await listInlineMcpSourceRecords(input, options);
    }
    catch (error) {
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
    const sessionsLogDir = path.join(hostContext.dataDir, 'sessions', group.folder, 'logs');
    ensurePrivateDirSync(sessionsLogDir);
    ensureWorkspaceIpcLayout(path.join(hostContext.dataDir, 'ipc', group.folder), 'inline');
    if (options.signal?.aborted)
        return abortedRunnerOutput('Inline agent');
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    let credentials;
    try {
        credentials = await getHostRuntimeCredentialEnv(group.folder.toLowerCase().replace(/_/g, '-'), options.credentialBroker, {
            purpose: 'model_runtime',
            runId: options.correlationRunId,
            runContext: input,
            modelRouteId: resolvedModel.value.modelEntry.modelRoute.id,
        });
    }
    catch (error) {
        options.signal?.removeEventListener('abort', abortFromCaller);
        return inlineFailure('Inline agent setup failed', error);
    }
    try {
        const mcpServers = await materializeInlineMcpServers(input, options, mcpSourceRecords);
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
    }
    catch (error) {
        return inlineFailure('Inline agent setup failed', error);
    }
    finally {
        options.signal?.removeEventListener('abort', abortFromCaller);
        await credentials.revoke?.().catch((error) => {
            logger.warn({ error, group: group.name }, 'Failed to revoke inline agent model gateway token');
        });
    }
}
async function executeInlineRun(input) {
    const controlPort = new InMemoryInlineRunnerControlPort();
    const handle = createInlineRunHandle(input.controller, controlPort);
    const runHandle = `gantry-inline-${input.group.folder}-${currentTimeMs()}-${randomUUID().slice(0, 8)}`;
    let providerSessionId;
    let active = true;
    let lastActivityAtMs = currentTimeMs();
    let lastTool;
    let totalToolCalls = 0;
    const pendingPermissionTools = new Map();
    const recordToolActivity = (toolName) => {
        lastTool = toolName;
        totalToolCalls += 1;
        lastActivityAtMs = currentTimeMs();
    };
    const jobActivity = {
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
    const deliverOutput = async (output, marksActivity) => {
        if (!active)
            return;
        resetTimeout();
        if (marksActivity)
            lastActivityAtMs = currentTimeMs();
        for (const event of output.runtimeEvents ?? []) {
            if (event.eventType !== RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY)
                continue;
            const payload = event.payload;
            if (payload?.phase !== 'started')
                continue;
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
            }
            catch (error) {
                logger.error({ error, group: input.group.name }, 'Inline agent output callback failed');
            }
        });
        await outputChain;
    };
    const emitOutput = (output) => deliverOutput(output, true);
    input.onProcess(handle, runHandle);
    if (input.controller.signal.aborted) {
        return abortedRunnerOutput('Inline agent', providerSessionId);
    }
    let timedOut = false;
    const configuredTimeoutMs = input.options.timeoutMs ??
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
        if (hasExplicitTimeout && !input.input.isScheduledJob)
            return;
        clearTimeout(timeout);
        timeout = armTimeout();
    };
    const scheduledIdleMs = scheduledJobIdleTimeoutMs();
    let scheduledIdleStall;
    const heartbeat = input.input.isScheduledJob
        ? async () => {
            const output = inlineHeartbeat(input.input, lastActivityAtMs, {
                lastTool,
                pendingPermissionToolNames: [...pendingPermissionTools.values()],
                totalToolCalls,
            });
            const payload = readScheduledJobHeartbeat(output) ?? undefined;
            await deliverOutput(output, false);
            if (payload &&
                (payload.pendingPermissionRequests ?? 0) === 0 &&
                (payload.lastActivityAgoMs ?? 0) >= scheduledIdleMs) {
                scheduledIdleStall = payload;
                input.controller.abort();
            }
        }
        : undefined;
    if (heartbeat)
        await heartbeat();
    const heartbeatTimer = heartbeat
        ? setInterval(() => void heartbeat(), INLINE_JOB_HEARTBEAT_INTERVAL_MS)
        : undefined;
    heartbeatTimer?.unref?.();
    const aborted = new Promise((resolve) => {
        const settle = () => resolve({
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
        if (input.controller.signal.aborted)
            settle();
        else
            input.controller.signal.addEventListener('abort', settle, {
                once: true,
            });
    });
    const lane = input.options.inlineAgentLoopLane ?? runInlineAgentLoopLane;
    const laneResult = Promise.resolve()
        .then(() => lane({
        group: input.group,
        correlationRunId: input.options.correlationRunId,
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
    }))
        .catch((error) => inlineFailure('Inline agent loop failed', error));
    const settledLane = laneResult.then((output) => ({
        kind: 'lane',
        output,
    }));
    try {
        const first = await Promise.race([settledLane, aborted]);
        if (first.kind === 'aborted')
            await settledLane;
        await outputChain;
        return outputWithProviderSession(first.output, providerSessionId);
    }
    finally {
        active = false;
        clearTimeout(timeout);
        if (heartbeatTimer)
            clearInterval(heartbeatTimer);
    }
}
async function listInlineMcpSourceRecords(input, options) {
    const serverIds = input.attachedMcpSourceIds ?? [];
    if (serverIds.length === 0 ||
        !options.mcpServerRepository ||
        !options.mcpContext?.appId ||
        !options.mcpContext.agentId) {
        return [];
    }
    return options.mcpServerRepository.listMaterializedServersForAgent({
        appId: options.mcpContext.appId,
        agentId: options.mcpContext.agentId,
        serverIds: serverIds,
    });
}
async function materializeInlineMcpServers(input, options, records) {
    if (records.length === 0 ||
        !options.mcpServerRepository ||
        !options.mcpContext?.appId ||
        !options.mcpContext.agentId) {
        return [];
    }
    const serverIds = records
        .filter(({ definition }) => (definition.transport === 'http' || definition.transport === 'sse') &&
        inlineMcpToolAuthority(input, definition.name).length > 0)
        .map(({ definition }) => definition.id);
    if (serverIds.length === 0)
        return [];
    const credentialEnv = options.capabilitySecretRepository
        ? await resolveMcpCredentialEnvForAgent({
            appId: options.mcpContext.appId,
            agentId: options.mcpContext.agentId,
            serverIds,
            mcpServers: options.mcpServerRepository,
            secrets: options.capabilitySecretRepository,
        })
        : {};
    const capabilities = await new McpServerService(options.mcpServerRepository, undefined, {
        lookupHostname: options.mcpHostnameLookup,
        dnsValidationCache: options.mcpDnsValidationCache,
    }).materializeForAgent({
        appId: options.mcpContext.appId,
        agentId: options.mcpContext.agentId,
        serverIds,
        credentialEnv,
    });
    return capabilities.flatMap((capability) => {
        const allowedToolNames = intersectInlineMcpToolScopes(capability.name, inlineMcpToolAuthority(input, capability.name), capability.allowedToolNames);
        if (allowedToolNames.length === 0)
            return [];
        const prefix = `mcp__${capability.name}__`;
        const autoApproveToolNames = intersectInlineMcpToolScopes(capability.name, allowedToolNames, capability.autoApproveToolNames);
        return [
            {
                ...capability,
                allowedToolNames,
                allowedToolPatterns: allowedToolNames.map((toolName) => toolName.slice(prefix.length)),
                autoApproveToolNames,
                autoApproveToolPatterns: autoApproveToolNames.map((toolName) => toolName.slice(prefix.length)),
            },
        ];
    });
}
function inlineMcpToolAuthority(input, serverName) {
    const prefix = `mcp__${serverName}__`;
    return (input.runtimeAccess ?? []).flatMap((access) => access.sourceType === 'mcp_server'
        ? access.allowedTools.filter((tool) => tool.startsWith(prefix))
        : []);
}
function intersectInlineMcpToolScopes(serverName, authority, sourceScope) {
    const prefix = `mcp__${serverName}__`;
    const patterns = new Set();
    for (const authorityTool of authority) {
        if (!authorityTool.startsWith(prefix))
            continue;
        const authorityPattern = authorityTool.slice(prefix.length);
        if (!authorityPattern)
            continue;
        for (const sourceTool of sourceScope) {
            if (!sourceTool.startsWith(prefix))
                continue;
            const sourcePattern = sourceTool.slice(prefix.length);
            if (!sourcePattern)
                continue;
            if (mcpToolPatternCovers(authorityPattern, sourcePattern)) {
                patterns.add(sourcePattern);
            }
            else if (mcpToolPatternCovers(sourcePattern, authorityPattern)) {
                patterns.add(authorityPattern);
            }
        }
    }
    return [...patterns].map((pattern) => `${prefix}${pattern}`);
}
function inlineHeartbeat(input, lastActivityAtMs, activity) {
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
function inlineFailure(prefix, error) {
    return {
        status: 'error',
        result: null,
        error: `${prefix}: ${error instanceof Error ? error.message : String(error)}`,
    };
}
