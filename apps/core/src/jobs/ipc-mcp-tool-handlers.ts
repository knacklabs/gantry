import path from 'path';

import { publishInvalidMcpToolRequestAudit } from '../application/mcp/mcp-tool-audit.js';
import type { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import { isActiveRunLeaseForInteraction } from '../application/interactions/pending-interaction-durability.js';
import {
  isAsyncTaskTerminal,
  toPublicAsyncTaskDto,
  type AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { readAsyncCommandSandboxPolicy } from '../runtime/async-command-sandbox-policy.js';
import {
  createAsyncMcpTask,
  executeAsyncMcpTask,
} from './async-mcp-tool-task.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { TaskHandler } from './ipc-types.js';
import {
  mcpCallToolProxyInput,
  mcpDescribeToolProxyInput,
  mcpListToolsProxyInput,
} from './ipc-mcp-list-tools-input.js';

type CreateMcpProxyForSourceGroup = (input: {
  appId: import('../domain/app/app.js').AppId;
  agentId: import('../domain/agent/agent.js').AgentId;
  deps: Parameters<TaskHandler>[0]['deps'];
  ipcDir?: string;
  runHandle?: string;
  runId?: string;
}) => Promise<McpToolProxy>;

export function createMcpToolHandlers(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): {
  mcpListToolsHandler: TaskHandler;
  mcpDescribeToolHandler: TaskHandler;
  mcpCallToolHandler: TaskHandler;
  asyncMcpCallToolHandler: TaskHandler;
} {
  return {
    mcpListToolsHandler: mcpListToolsHandler(createMcpProxyForSourceGroup),
    mcpDescribeToolHandler: mcpDescribeToolHandler(
      createMcpProxyForSourceGroup,
    ),
    mcpCallToolHandler: mcpCallToolHandler(createMcpProxyForSourceGroup),
    asyncMcpCallToolHandler: asyncMcpCallToolHandler(
      createMcpProxyForSourceGroup,
    ),
  };
}

function mcpListToolsHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
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
    if (!requestedTargetJid) return;
    try {
      const listInput = mcpListToolsProxyInput(data.payload || {});
      const agentId = agentIdForMcpTask(data, sourceAgentFolder);
      const proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId: data.runId,
      });
      const result = await proxy.listTools({
        appId: data.appId as never,
        agentId,
        ...listInput,
      });
      acceptData('Connected MCP tools listed for this agent.', result);
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'MCP tool listing failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

function mcpDescribeToolHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
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
    if (!requestedTargetJid) return;
    try {
      const detailInput = mcpDescribeToolProxyInput(data.payload || {});
      if (!detailInput.serverName || !detailInput.toolName) {
        reject(
          'Missing required fields: serverName and toolName.',
          'invalid_request',
        );
        return;
      }
      const agentId = agentIdForMcpTask(data, sourceAgentFolder);
      const proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId: data.runId,
      });
      const result = await proxy.describeTool({
        appId: data.appId as never,
        agentId,
        serverName: detailInput.serverName,
        toolName: detailInput.toolName,
      });
      acceptData(
        `MCP tool ${detailInput.serverName}.${detailInput.toolName} described.`,
        result,
      );
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'MCP tool detail failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

function mcpCallToolHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
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
    if (!requestedTargetJid) return;
    try {
      const callInput = mcpCallToolProxyInput(data.payload || {});
      if (
        !callInput.serverName ||
        !callInput.toolName ||
        callInput.invalidArguments
      ) {
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
        appId: data.appId as never,
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
        reject(
          'MCP tool call rejected because the run lease is no longer active.',
          'stale_run_lease',
        );
        return;
      }
      const result = await proxy.callTool({
        appId: data.appId as never,
        agentId,
        serverName,
        toolName,
        arguments: callInput.arguments ?? {},
      });
      acceptData(`MCP tool ${serverName}.${toolName} completed.`, result);
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'MCP tool call failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

function asyncMcpCallToolHandler(
  createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup,
): TaskHandler {
  return async (context) => {
    const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
    const { acceptData, reject } = createTaskResponder(
      sourceAgentFolder,
      data.taskId,
      data.authThreadId,
      data.responseKeyId,
    );
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
    if (!requestedTargetJid) return;
    try {
      const callInput = mcpCallToolProxyInput(data.payload || {});
      if (
        !callInput.serverName ||
        !callInput.toolName ||
        callInput.invalidArguments
      ) {
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
      const parentTask = await validateAsyncMcpParentTask({
        repository,
        data,
        appId: data.appId,
        agentId: agentIdForMcpTask(data, sourceAgentFolder),
        conversationId: requestedTargetJid,
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
        reject(
          'Async MCP tool call rejected because the run lease is no longer active.',
          'stale_run_lease',
        );
        return;
      }
      const { serverName, toolName } = callInput;
      const agentId = agentIdForMcpTask(data, sourceAgentFolder);
      const sandboxPolicy = readAsyncCommandSandboxPolicy({
        sourceAgentFolder,
        runHandle: data.runHandle,
      });
      if (
        !sandboxPolicy ||
        sandboxPolicy.appId !== data.appId ||
        (sandboxPolicy.agentId && sandboxPolicy.agentId !== agentId) ||
        sandboxPolicy.conversationId !== requestedTargetJid ||
        (sandboxPolicy.threadId ?? null) !==
          (data.authThreadId || data.threadId || null) ||
        (sandboxPolicy.runId && sandboxPolicy.runId !== data.runId) ||
        (sandboxPolicy.jobId && sandboxPolicy.jobId !== data.jobId)
      ) {
        reject(
          'async_mcp_call must target a run where async task tools are mounted.',
          'forbidden',
        );
        return;
      }
      const proxy = await createMcpProxyForSourceGroup({
        appId: data.appId as never,
        agentId,
        deps,
        ipcDir: context.ipcBaseDir
          ? path.join(context.ipcBaseDir, sourceAgentFolder)
          : undefined,
        runHandle: data.runHandle,
        runId: data.runId,
      });
      await proxy.assertToolAllowed({
        appId: data.appId as never,
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
        threadId: data.authThreadId || data.threadId || null,
        parentTaskId: parentTask.parentTaskId,
        jobId: data.jobId,
        runId: data.runId,
        serverName,
        toolName,
      });
      if (!taskResult.ok) {
        reject(taskResult.message, 'capacity_full');
        return;
      }
      void executeAsyncMcpTask({
        repository,
        task: taskResult.task,
        proxy,
        appId: data.appId,
        agentId,
        serverName,
        toolName,
        arguments: callInput.arguments ?? {},
      });
      acceptData(`Started: ${serverName}.${toolName}`, {
        task: toPublicAsyncTaskDto(taskResult.task),
      });
    } catch (err) {
      reject(
        err instanceof Error ? err.message : 'Async MCP tool call failed.',
        'mcp_proxy_failed',
      );
    }
  };
}

async function validateAsyncMcpParentTask(input: {
  repository: AsyncTaskRepository;
  data: Parameters<TaskHandler>[0]['data'];
  appId: string;
  agentId: string;
  conversationId: string;
  threadId?: string | null;
}): Promise<
  { ok: true; parentTaskId: string | null } | { ok: false; message: string }
> {
  const parentTaskId = toTrimmedString(input.data.parentTaskId, {
    maxLen: 120,
  });
  if (!parentTaskId) return { ok: true, parentTaskId: null };
  const parent = await input.repository.getTask(parentTaskId);
  const valid =
    parent &&
    parent.kind === 'delegated_agent' &&
    parent.appId === input.appId &&
    parent.agentId === input.agentId &&
    parent.conversationId === input.conversationId &&
    (parent.threadId ?? null) === (input.threadId ?? null) &&
    !isAsyncTaskTerminal(parent.status);
  return valid
    ? { ok: true, parentTaskId }
    : { ok: false, message: 'async_mcp_call parent task is not active.' };
}

async function auditInvalidMcpCallRequest(input: {
  data: Parameters<TaskHandler>[0]['data'];
  deps: Parameters<TaskHandler>[0]['deps'];
  sourceAgentFolder: string;
  callInput: ReturnType<typeof mcpCallToolProxyInput>;
  reason: string;
}): Promise<void> {
  const mcpServers = input.deps.getMcpServerRepository?.();
  if (!mcpServers) {
    throw new Error('MCP tool call audit repository unavailable.');
  }
  await publishInvalidMcpToolRequestAudit({
    mcpServers,
    publishRuntimeEvent: input.deps.publishRuntimeEvent,
    appId: input.data.appId as never,
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

function agentIdForMcpTask(
  data: Parameters<TaskHandler>[0]['data'],
  sourceAgentFolder: string,
) {
  return (data.agentId ||
    memoryAgentIdForWorkspaceFolder(sourceAgentFolder)) as never;
}

function validateSameChannelMcpTarget(input: {
  data: Parameters<TaskHandler>[0]['data'];
  sourceAgentFolderJids: string[];
  requestKind: string;
  reject: (error: string, code?: string, details?: string[]) => void;
}): string | null {
  const requestedTargetJid = toTrimmedString(input.data.chatJid, {
    maxLen: 512,
  });
  const targetOverride = toTrimmedString(
    input.data.targetJid || input.data.jid,
    { maxLen: 512 },
  );
  if (targetOverride && targetOverride !== requestedTargetJid) {
    input.reject(
      `${input.requestKind} requests must use the originating chat as the approval target.`,
      'forbidden',
    );
    return null;
  }
  if (
    !requestedTargetJid ||
    !input.sourceAgentFolderJids.includes(requestedTargetJid)
  ) {
    input.reject(
      `${input.requestKind} requests must include the originating chat for this agent.`,
      'forbidden',
    );
    return null;
  }
  return requestedTargetJid;
}
