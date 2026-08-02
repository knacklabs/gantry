import path from 'path';
import { publishInvalidMcpToolRequestAudit } from '../application/mcp/mcp-tool-audit.js';
import { isActiveRunLeaseForInteraction } from '../application/interactions/pending-interaction-durability.js';
import { isAsyncTaskTerminal, toPublicAsyncTaskDto, } from '../domain/ports/async-tasks.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { readAsyncCommandSandboxPolicy } from '../runtime/async-command-sandbox-policy.js';
import { createAsyncMcpTask, enqueueAsyncMcpTask, } from './async-mcp-tool-task.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { mcpCallToolProxyInput, mcpDescribeToolProxyInput, mcpListToolsProxyInput, } from './ipc-mcp-list-tools-input.js';
import { delegatedTaskAgentInScope } from './async-command-task-helpers.js';
export function createMcpToolHandlers(createMcpProxyForSourceGroup) {
    return {
        mcpListToolsHandler: mcpListToolsHandler(createMcpProxyForSourceGroup),
        mcpSearchToolsHandler: mcpSearchToolsHandler(createMcpProxyForSourceGroup),
        mcpDescribeToolHandler: mcpDescribeToolHandler(createMcpProxyForSourceGroup),
        mcpCallToolHandler: mcpCallToolHandler(createMcpProxyForSourceGroup),
        asyncMcpCallToolHandler: asyncMcpCallToolHandler(createMcpProxyForSourceGroup),
    };
}
function mcpSearchToolsHandler(createMcpProxyForSourceGroup) {
    return async (context) => {
        const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
        const { acceptData, reject } = createTaskResponder(sourceAgentFolder, data.taskId, data.authThreadId, data.responseKeyId);
        if (!data.appId) {
            reject('MCP tool search requires signed app scope.', 'forbidden');
            return;
        }
        const requestedTargetJid = validateSameChannelMcpTarget({
            data,
            sourceAgentFolderJids,
            requestKind: 'MCP tool search',
            reject,
        });
        if (!requestedTargetJid)
            return;
        try {
            const searchInput = mcpListToolsProxyInput(data.payload || {});
            if (!searchInput.query) {
                reject('Missing required field: query.', 'invalid_request');
                return;
            }
            const agentId = agentIdForMcpTask(data, sourceAgentFolder);
            const proxy = await createMcpProxyForSourceGroup({
                appId: data.appId,
                agentId,
                deps,
                ipcDir: context.ipcBaseDir
                    ? path.join(context.ipcBaseDir, sourceAgentFolder)
                    : undefined,
                runHandle: data.runHandle,
                runId: data.runId,
            });
            const result = await proxy.searchTools({
                appId: data.appId,
                agentId,
                query: searchInput.query,
                limit: searchInput.limit,
            });
            acceptData('Connected MCP tools searched for this agent.', result);
        }
        catch (err) {
            reject(err instanceof Error ? err.message : 'MCP tool search failed.', 'mcp_proxy_failed');
        }
    };
}
function mcpListToolsHandler(createMcpProxyForSourceGroup) {
    return async (context) => {
        const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
        const { acceptData, reject } = createTaskResponder(sourceAgentFolder, data.taskId, data.authThreadId, data.responseKeyId);
        if (!data.appId) {
            reject('MCP tool listing requires signed app scope.', 'forbidden');
            return;
        }
        const requestedTargetJid = validateSameChannelMcpTarget({
            data,
            sourceAgentFolderJids,
            requestKind: 'MCP tool list',
            reject,
        });
        if (!requestedTargetJid)
            return;
        try {
            const listInput = mcpListToolsProxyInput(data.payload || {});
            const agentId = agentIdForMcpTask(data, sourceAgentFolder);
            const proxy = await createMcpProxyForSourceGroup({
                appId: data.appId,
                agentId,
                deps,
                ipcDir: context.ipcBaseDir
                    ? path.join(context.ipcBaseDir, sourceAgentFolder)
                    : undefined,
                runHandle: data.runHandle,
                runId: data.runId,
            });
            const result = await proxy.listTools({
                appId: data.appId,
                agentId,
                ...listInput,
            });
            acceptData('Connected MCP tools listed for this agent.', result);
        }
        catch (err) {
            reject(err instanceof Error ? err.message : 'MCP tool listing failed.', 'mcp_proxy_failed');
        }
    };
}
function mcpDescribeToolHandler(createMcpProxyForSourceGroup) {
    return async (context) => {
        const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
        const { acceptData, reject } = createTaskResponder(sourceAgentFolder, data.taskId, data.authThreadId, data.responseKeyId);
        if (!data.appId) {
            reject('MCP tool detail requires signed app scope.', 'forbidden');
            return;
        }
        const requestedTargetJid = validateSameChannelMcpTarget({
            data,
            sourceAgentFolderJids,
            requestKind: 'MCP tool detail',
            reject,
        });
        if (!requestedTargetJid)
            return;
        try {
            const detailInput = mcpDescribeToolProxyInput(data.payload || {});
            if (!detailInput.serverName || !detailInput.toolName) {
                reject('Missing required fields: serverName and toolName.', 'invalid_request');
                return;
            }
            const agentId = agentIdForMcpTask(data, sourceAgentFolder);
            const proxy = await createMcpProxyForSourceGroup({
                appId: data.appId,
                agentId,
                deps,
                ipcDir: context.ipcBaseDir
                    ? path.join(context.ipcBaseDir, sourceAgentFolder)
                    : undefined,
                runHandle: data.runHandle,
                runId: data.runId,
            });
            const result = await proxy.describeTool({
                appId: data.appId,
                agentId,
                serverName: detailInput.serverName,
                toolName: detailInput.toolName,
            });
            acceptData(`MCP tool ${detailInput.serverName}.${detailInput.toolName} described.`, result);
        }
        catch (err) {
            reject(err instanceof Error ? err.message : 'MCP tool detail failed.', 'mcp_proxy_failed');
        }
    };
}
function mcpCallToolHandler(createMcpProxyForSourceGroup) {
    return async (context) => {
        const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
        const { acceptData, reject } = createTaskResponder(sourceAgentFolder, data.taskId, data.authThreadId, data.responseKeyId);
        if (!data.appId) {
            reject('MCP tool calls require signed app scope.', 'forbidden');
            return;
        }
        const requestedTargetJid = validateSameChannelMcpTarget({
            data,
            sourceAgentFolderJids,
            requestKind: 'MCP tool call',
            reject,
        });
        if (!requestedTargetJid)
            return;
        try {
            const callInput = mcpCallToolProxyInput(data.payload || {});
            if (!callInput.serverName ||
                !callInput.toolName ||
                callInput.invalidArguments) {
                const reason = callInput.invalidArguments
                    ? 'mcp_call_tool arguments must be a JSON object when provided.'
                    : 'Missing required fields: serverName and toolName.';
                await auditInvalidMcpCallRequest({
                    data,
                    deps,
                    sourceAgentFolder,
                    callInput,
                    reason,
                });
                reject(reason, 'invalid_request');
                return;
            }
            const { serverName, toolName } = callInput;
            const agentId = agentIdForMcpTask(data, sourceAgentFolder);
            const proxy = await createMcpProxyForSourceGroup({
                appId: data.appId,
                agentId,
                deps,
                ipcDir: context.ipcBaseDir
                    ? path.join(context.ipcBaseDir, sourceAgentFolder)
                    : undefined,
                runHandle: data.runHandle,
                runId: data.runId,
            });
            const activeLease = await isActiveRunLeaseForInteraction({
                runId: data.runId,
                runLeaseToken: data.runLeaseToken,
                runLeaseFencingVersion: data.runLeaseFencingVersion,
            });
            if (!activeLease) {
                reject('MCP tool call rejected because the run lease is no longer active.', 'stale_run_lease');
                return;
            }
            const result = await proxy.callTool({
                appId: data.appId,
                agentId,
                serverName,
                toolName,
                arguments: callInput.arguments ?? {},
            });
            acceptData(`MCP tool ${serverName}.${toolName} completed.`, preserveRemoteMcpError(result));
        }
        catch (err) {
            reject(err instanceof Error ? err.message : 'MCP tool call failed.', 'mcp_proxy_failed');
        }
    };
}
function preserveRemoteMcpError(result) {
    if (!isRemoteMcpErrorResult(result))
        return result;
    return {
        ...result,
        error: remoteMcpError(result),
    };
}
function remoteMcpError(result) {
    const error = result.error;
    if (error &&
        typeof error === 'object' &&
        !Array.isArray(error) &&
        ['transient', 'validation', 'business', 'permission'].includes(String(error.category)) &&
        typeof error.isRetryable === 'boolean' &&
        typeof error.message === 'string') {
        return error;
    }
    return {
        category: 'business',
        isRetryable: false,
        message: remoteMcpErrorMessage(result),
    };
}
function isRemoteMcpErrorResult(result) {
    return (result !== null &&
        typeof result === 'object' &&
        !Array.isArray(result) &&
        result.isError === true);
}
function remoteMcpErrorMessage(result) {
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.find((item) => item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        item.type === 'text' &&
        typeof item.text === 'string')?.text;
    return text?.trim().slice(0, 2_000) || 'Remote MCP tool returned an error.';
}
function asyncMcpCallToolHandler(createMcpProxyForSourceGroup) {
    return async (context) => {
        const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
        const { acceptData, reject } = createTaskResponder(sourceAgentFolder, data.taskId, data.authThreadId, data.responseKeyId);
        if (!data.appId) {
            reject('Async MCP tool calls require signed app scope.', 'forbidden');
            return;
        }
        const requestedTargetJid = validateSameChannelMcpTarget({
            data,
            sourceAgentFolderJids,
            requestKind: 'Async MCP tool call',
            reject,
        });
        if (!requestedTargetJid)
            return;
        try {
            const callInput = mcpCallToolProxyInput(data.payload || {});
            if (!callInput.serverName ||
                !callInput.toolName ||
                callInput.invalidArguments) {
                const reason = callInput.invalidArguments
                    ? 'async_mcp_call arguments must be a JSON object when provided.'
                    : 'Missing required fields: serverName and toolName.';
                await auditInvalidMcpCallRequest({
                    data,
                    deps,
                    sourceAgentFolder,
                    callInput,
                    reason,
                });
                reject(reason, 'invalid_request');
                return;
            }
            const repository = deps.getAsyncTaskRepository?.();
            if (!repository || deps.runnerSandboxProvider?.enforcing !== true) {
                reject('Async task runtime is unavailable.', 'unavailable');
                return;
            }
            const agentId = agentIdForMcpTask(data, sourceAgentFolder);
            const sandboxPolicy = readAsyncCommandSandboxPolicy({
                sourceAgentFolder,
                runHandle: data.runHandle,
            });
            if (!sandboxPolicy ||
                sandboxPolicy.appId !== data.appId ||
                (sandboxPolicy.agentId && sandboxPolicy.agentId !== agentId) ||
                sandboxPolicy.conversationId !== requestedTargetJid ||
                (sandboxPolicy.providerAccountId &&
                    sandboxPolicy.providerAccountId !== data.providerAccountId) ||
                (sandboxPolicy.threadId ?? null) !==
                    (data.authThreadId || data.threadId || null) ||
                (sandboxPolicy.runId && sandboxPolicy.runId !== data.runId) ||
                (sandboxPolicy.jobId && sandboxPolicy.jobId !== data.jobId)) {
                reject('async_mcp_call must target a run where async task tools are mounted.', 'forbidden');
                return;
            }
            const parentTask = await validateAsyncMcpParentTask({
                repository,
                data,
                appId: data.appId,
                agentId,
                conversationId: requestedTargetJid,
                providerAccountId: sandboxPolicy.providerAccountId ?? null,
                threadId: data.authThreadId || data.threadId || null,
            });
            if (!parentTask.ok) {
                reject(parentTask.message, 'invalid_request');
                return;
            }
            const activeLease = await isActiveRunLeaseForInteraction({
                runId: data.runId,
                runLeaseToken: data.runLeaseToken,
                runLeaseFencingVersion: data.runLeaseFencingVersion,
            });
            if (!activeLease) {
                reject('Async MCP tool call rejected because the run lease is no longer active.', 'stale_run_lease');
                return;
            }
            const { serverName, toolName } = callInput;
            const proxy = await createMcpProxyForSourceGroup({
                appId: data.appId,
                agentId,
                deps,
                ipcDir: context.ipcBaseDir
                    ? path.join(context.ipcBaseDir, sourceAgentFolder)
                    : undefined,
                runHandle: data.runHandle,
                runId: data.runId,
            });
            await proxy.assertToolAllowed({
                appId: data.appId,
                agentId,
                serverName,
                toolName,
                arguments: callInput.arguments ?? {},
            });
            const taskResult = await createAsyncMcpTask({
                repository,
                appId: data.appId,
                agentId,
                conversationId: requestedTargetJid,
                providerAccountId: sandboxPolicy.providerAccountId ?? null,
                threadId: data.authThreadId || data.threadId || null,
                parentTaskId: parentTask.parentTaskId,
                jobId: data.jobId,
                runId: data.runId,
                serverName,
                toolName,
                arguments: callInput.arguments ?? {},
            });
            if (!taskResult.ok) {
                reject(taskResult.message, 'capacity_full');
                return;
            }
            await enqueueAsyncMcpTask({
                repository,
                task: taskResult.task,
                proxy,
                appId: data.appId,
                agentId,
                serverName,
                toolName,
                arguments: callInput.arguments ?? {},
            });
            acceptData(`Queued: ${serverName}.${toolName}`, {
                task: toPublicAsyncTaskDto(taskResult.task),
            });
        }
        catch (err) {
            reject(err instanceof Error ? err.message : 'Async MCP tool call failed.', 'mcp_proxy_failed');
        }
    };
}
async function validateAsyncMcpParentTask(input) {
    const parentTaskId = toTrimmedString(input.data.parentTaskId, {
        maxLen: 120,
    });
    if (!parentTaskId)
        return { ok: true, parentTaskId: null };
    const parent = await input.repository.getTask(parentTaskId);
    const valid = parent &&
        parent.kind === 'delegated_agent' &&
        parent.appId === input.appId &&
        delegatedTaskAgentInScope(parent, input.agentId) &&
        parent.conversationId === input.conversationId &&
        (parent.privateCorrelationJson.providerAccountId ?? null) ===
            (input.providerAccountId ?? null) &&
        (parent.threadId ?? null) === (input.threadId ?? null) &&
        !isAsyncTaskTerminal(parent.status);
    return valid
        ? { ok: true, parentTaskId }
        : { ok: false, message: 'async_mcp_call parent task is not active.' };
}
async function auditInvalidMcpCallRequest(input) {
    const mcpServers = input.deps.getMcpServerRepository?.();
    if (!mcpServers) {
        throw new Error('MCP tool call audit repository unavailable.');
    }
    await publishInvalidMcpToolRequestAudit({
        mcpServers,
        publishRuntimeEvent: input.deps.publishRuntimeEvent,
        appId: input.data.appId,
        agentId: agentIdForMcpTask(input.data, input.sourceAgentFolder),
        ...(input.data.runId ? { runId: input.data.runId } : {}),
        ...(input.data.runHandle ? { runHandle: input.data.runHandle } : {}),
        ...(input.callInput.serverName
            ? { serverName: input.callInput.serverName }
            : {}),
        ...(input.callInput.toolName ? { toolName: input.callInput.toolName } : {}),
        argumentPayload: input.callInput.argumentPayload,
        reason: input.reason,
        missingFields: input.callInput.missingFields,
    });
}
function agentIdForMcpTask(data, sourceAgentFolder) {
    return (data.agentId ||
        memoryAgentIdForWorkspaceFolder(sourceAgentFolder));
}
function validateSameChannelMcpTarget(input) {
    const requestedTargetJid = toTrimmedString(input.data.chatJid, {
        maxLen: 512,
    });
    const targetOverride = toTrimmedString(input.data.targetJid || input.data.jid, { maxLen: 512 });
    if (targetOverride && targetOverride !== requestedTargetJid) {
        input.reject(`${input.requestKind} requests must use the originating chat as the approval target.`, 'forbidden');
        return null;
    }
    if (!requestedTargetJid ||
        !input.sourceAgentFolderJids.includes(requestedTargetJid)) {
        input.reject(`${input.requestKind} requests must include the originating chat for this agent.`, 'forbidden');
        return null;
    }
    return requestedTargetJid;
}
