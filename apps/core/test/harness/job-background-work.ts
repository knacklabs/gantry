import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, vi } from 'vitest';

import type {
  AgentInput,
  AgentOutput,
} from '@core/runtime/agent-spawn-types.js';
import type { ConversationRoute } from '@core/domain/types.js';
import type { TaskContext } from '@core/jobs/ipc-types.js';
import type { RunnerSandboxProvider } from '@core/shared/runner-sandbox-provider.js';
import type { PostgresIntegrationRuntime } from './postgres-integration-runtime.js';

export const BACKGROUND_FOLDER = 'background_agent';
export const BACKGROUND_AGENT = 'agent:background_agent';
export const BACKGROUND_JID = 'tg:background-work';
const NOW = '2026-10-09T00:00:00.000Z';

export async function createJobBackgroundHarness(
  runtime: PostgresIntegrationRuntime,
) {
  const { _setRuntimeStorageForTest } =
    await import('@core/adapters/storage/postgres/runtime-store.js');
  const { configurePendingInteractionDurability } =
    await import('@core/application/interactions/pending-interaction-durability.js');
  const { registerWorkerInstance } =
    await import('@core/jobs/worker-identity.js');
  const { _resetSchedulerLoopForTests, runJob } =
    await import('@core/jobs/scheduler.js');
  const {
    registerAsyncCommandSandboxPolicy,
    releaseAsyncCommandSandboxPolicy,
  } = await import('@core/runtime/async-command-sandbox-policy.js');
  const { createIpcAuthEnvelope } = await import('@core/runtime/ipc-auth.js');
  const { agentTaskLifecycleHandlers } =
    await import('@core/jobs/ipc-agent-task-lifecycle-handlers.js');
  const { createMcpToolHandlers } =
    await import('@core/jobs/ipc-mcp-tool-handlers.js');
  const { resolveWorkspaceFolderPath } =
    await import('@core/platform/workspace-folder.js');
  _setRuntimeStorageForTest(runtime.storageRuntime);
  configurePendingInteractionDurability({
    repository: runtime.repositories.workerCoordination,
  });
  _resetSchedulerLoopForTests();
  await registerWorkerInstance(runtime.repositories.workerCoordination);
  await runtime.repositories.agents.saveAgent({
    id: BACKGROUND_AGENT as never,
    appId: 'default' as never,
    name: 'Background Agent',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const catalog = await runtime.repositories.tools.listTools({
    appId: 'default' as never,
  });
  for (const name of ['AgentDelegation', 'RunCommand(printf *)']) {
    const toolId =
      catalog.find((tool) => tool.name === name)?.id ??
      `tool:background:${name}`;
    if (!catalog.some((tool) => tool.id === toolId))
      await runtime.repositories.tools.saveTool({
        id: toolId as never,
        appId: 'default' as never,
        name,
        kind: 'host',
        provider: 'gantry',
        displayName: name,
        category: 'productivity',
        risk: 'high',
        selectable: true,
        status: 'active',
        adapterRef: name,
        inputSchema: {},
        createdAt: NOW,
        updatedAt: NOW,
      });
    await runtime.repositories.tools.saveAgentToolBinding({
      id: `binding:background:${name}` as never,
      appId: 'default' as never,
      agentId: BACKGROUND_AGENT as never,
      toolId: toolId as never,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  fs.mkdirSync(resolveWorkspaceFolderPath(BACKGROUND_FOLDER), {
    recursive: true,
  });
  const processes = new Set<ChildProcess>();
  // Execute the command, rather than supplying its asserted outcome.
  const sandbox: RunnerSandboxProvider = {
    id: 'sandbox_runtime',
    enforcing: true,
    start(input) {
      const child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        detached: true,
        stdio: 'pipe',
      });
      processes.add(child);
      child.once('close', () => processes.delete(child));
      return child;
    },
  };
  const group: ConversationRoute = {
    name: 'Background Agent',
    folder: BACKGROUND_FOLDER,
    agentId: BACKGROUND_AGENT,
    trigger: '',
    added_at: NOW,
    requiresTrigger: false,
    conversationKind: 'channel',
    conversationId: 'conversation:background-work',
  };
  const routes = { [BACKGROUND_JID]: group };
  const sent: string[] = [];
  let releaseMcp!: () => void;
  const mcpResult = new Promise<void>((resolve) => {
    releaseMcp = resolve;
  });
  const { McpServerService } =
    await import('@core/application/mcp/mcp-server-service.js');
  const { McpToolProxy, MCP_TOOL_PROXY_CLIENT_ADAPTERS } =
    await import('@core/application/mcp/mcp-tool-proxy.js');
  const { closeCachedMcpClient } =
    await import('@core/application/mcp/mcp-tool-proxy-client-cache.js');
  const { semanticCapabilityInputSchema } =
    await import('@core/shared/semantic-capabilities.js');
  const mcpServers = new McpServerService(
    runtime.repositories.mcpServers,
    runtime.repositories.agents,
  );
  const server = await mcpServers.connectServer({
    appId: 'default' as never,
    name: 'remote',
    transportConfig: { transport: 'http', url: 'http://127.0.0.1:39999/mcp' },
    allowedToolPatterns: ['report'],
  });
  await mcpServers.bindToAgent({
    appId: 'default' as never,
    agentId: BACKGROUND_AGENT as never,
    serverId: server.id,
  });
  const capabilityToolId = 'tool:capability:background.report' as never;
  await runtime.repositories.tools.saveTool({
    id: capabilityToolId,
    appId: 'default' as never,
    name: 'capability:background.report',
    kind: 'host',
    provider: 'gantry',
    displayName: 'Background report',
    category: 'mcp',
    risk: 'low',
    selectable: true,
    status: 'active',
    adapterRef: 'capability/background.report',
    inputSchema: semanticCapabilityInputSchema({
      capabilityId: 'background.report',
      displayName: 'Background report',
      category: 'mcp',
      risk: 'read',
      can: 'Read the remote report.',
      cannot: 'Call other remote tools.',
      credentialSource: 'none',
      implementationBindings: [
        {
          kind: 'mcp_pattern',
          mcpServer: 'remote',
          mcpToolPatterns: ['report'],
        },
      ],
      preflight: { kind: 'none' },
    }),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await runtime.repositories.tools.saveAgentToolBinding({
    id: 'binding:background:report' as never,
    appId: 'default' as never,
    agentId: BACKGROUND_AGENT as never,
    toolId: capabilityToolId,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const client = MCP_TOOL_PROXY_CLIENT_ADAPTERS.createClient(() => {});
  const clientSpies = [
    vi.spyOn(client, 'connect').mockResolvedValue(undefined),
    vi.spyOn(client, 'close').mockResolvedValue(undefined),
    vi.spyOn(client, 'listTools').mockResolvedValue({
      tools: [{ name: 'report', inputSchema: { type: 'object' } }],
    }),
    vi.spyOn(client, 'callTool').mockImplementation(async () => {
      await mcpResult;
      return { content: [{ type: 'text', text: 'Remote tool finished.' }] };
    }),
    vi
      .spyOn(MCP_TOOL_PROXY_CLIENT_ADAPTERS, 'createClient')
      .mockReturnValue(client),
  ];
  const proxy = new McpToolProxy(runtime.repositories.mcpServers, {
    tools: runtime.repositories.tools,
    skills: runtime.repositories.skills,
  });
  let request = 0;
  const deps = {
    opsRepository: runtime.ops,
    getAsyncTaskRepository: () => runtime.repositories.asyncTasks,
    getToolRepository: () => runtime.repositories.tools,
    runnerSandboxProvider: sandbox,
    runAgent: async (): Promise<AgentOutput> => ({
      status: 'success',
      result: 'Subagent finished.',
    }),
  };
  const mcp = createMcpToolHandlers(async () => proxy);

  async function invoke(
    input: AgentInput,
    type: 'async_run_command' | 'async_mcp_call' | 'delegate_task',
    payload: Record<string, unknown>,
  ) {
    const id = `background-request-${++request}`;
    const auth = createIpcAuthEnvelope(BACKGROUND_FOLDER);
    registerAsyncCommandSandboxPolicy({
      sourceAgentFolder: BACKGROUND_FOLDER,
      runHandle: id,
      policy: {
        appId: 'default',
        agentId: BACKGROUND_AGENT,
        conversationId: BACKGROUND_JID,
        runId: input.runId,
        correlationRunId: input.runId,
        jobId: input.jobId,
        protectedReadPaths: [],
        protectedWritePaths: [],
        allowedNetworkHosts: [],
        resourceLimits: { cpuSeconds: 30, memoryMb: 128, maxProcesses: 16 },
      },
    });
    try {
      const context: TaskContext = {
        data: {
          type,
          taskId: id,
          appId: 'default',
          agentId: BACKGROUND_AGENT,
          chatJid: BACKGROUND_JID,
          jid: BACKGROUND_JID,
          responseKeyId: auth.responseKeyId,
          runHandle: id,
          runId: input.runId,
          jobId: input.jobId,
          runLeaseToken: input.runLeaseToken,
          runLeaseFencingVersion: input.runLeaseFencingVersion,
          payload,
        },
        sourceAgentFolder: BACKGROUND_FOLDER,
        sourceAgentFolderJids: [BACKGROUND_JID],
        conversationBindings: routes,
        deps: deps as TaskContext['deps'],
      };
      await (
        type === 'async_mcp_call'
          ? mcp.asyncMcpCallToolHandler
          : agentTaskLifecycleHandlers[type]
      )(context);
      const { DATA_DIR } = await import('@core/config/index.js');
      const response = JSON.parse(
        fs.readFileSync(
          path.join(
            DATA_DIR,
            'ipc',
            BACKGROUND_FOLDER,
            'task-responses',
            `task-${id}.json`,
          ),
          'utf8',
        ),
      ) as {
        ok: boolean;
        message?: string;
        data?: { id?: string; task?: { id: string } };
      };
      expect(response, response.message).toMatchObject({ ok: true });
      return response.data?.id ?? response.data?.task?.id;
    } finally {
      releaseAsyncCommandSandboxPolicy(BACKGROUND_FOLDER, id);
    }
  }

  async function tasksForJob(jobId: string) {
    const { quotePostgresIdentifier } =
      await import('@core/adapters/storage/postgres/storage-service.js');
    const result = await runtime.service.pool.query<{
      id: string;
      parent_run_id: string | null;
      parent_job_id: string | null;
      kind: string;
      status: string;
      output_summary: string | null;
    }>(
      `SELECT id, parent_run_id, parent_job_id, kind, status, output_summary FROM ${quotePostgresIdentifier(runtime.schemaName)}.agent_async_tasks WHERE parent_job_id = $1 ORDER BY created_at`,
      [jobId],
    );
    return result.rows;
  }

  async function saveJob(jobId: string) {
    await runtime.ops.upsertJob({
      id: jobId,
      name: 'Background work',
      prompt: 'Run background work.',
      schedule_type: 'interval',
      schedule_value: '60000',
      status: 'active',
      session_id: null,
      thread_id: null,
      workspace_key: BACKGROUND_FOLDER,
      execution_context: {
        conversationJid: BACKGROUND_JID,
        threadId: null,
        workspaceKey: BACKGROUND_FOLDER,
        sessionId: null,
      },
      notification_routes: [
        { conversationJid: BACKGROUND_JID, threadId: null, label: 'primary' },
      ],
      created_by: 'human',
      created_at: NOW,
      updated_at: NOW,
      next_run: NOW,
      silent: false,
      timeout_ms: 30_000,
      max_retries: 0,
      retry_backoff_ms: 1,
    });
  }

  async function dispatch(
    jobId: string,
    execute: (input: AgentInput) => Promise<string>,
  ) {
    await saveJob(jobId);
    const job = await runtime.ops.getJobById(jobId);
    if (!job) throw new Error('Scheduled job was not saved.');
    await runJob(
      job,
      {
        conversationRoutes: () => routes,
        queue: {} as never,
        onProcess: () => {},
        sendMessage: async (_jid, text) => {
          sent.push(text);
        },
        opsRepository: runtime.ops,
        runAgent: async (_group, input) => ({
          status: 'success',
          result: await execute(input),
        }),
      },
      BACKGROUND_JID,
      { triggerId: `trigger:${jobId}`, scheduledFor: NOW },
    );
    const [run] = await runtime.ops.listJobRuns(jobId);
    expect(run, run?.error_summary ?? undefined).toMatchObject({
      status: 'completed',
    });
    return run!;
  }

  async function waitForTask(id: string) {
    await vi.waitFor(
      async () => {
        expect(await runtime.repositories.asyncTasks.getTask(id)).toMatchObject(
          { status: 'completed' },
        );
      },
      { timeout: 10_000, interval: 10 },
    );
    return (await runtime.repositories.asyncTasks.getTask(id))!;
  }

  return {
    group,
    routes,
    sandbox,
    invoke,
    dispatch,
    saveJob,
    tasksForJob,
    waitForTask,
    sent,
    releaseMcp,
    async cleanup() {
      try {
        releaseMcp();
        const exited = [...processes].map(
          (child) =>
            new Promise<void>((resolve) =>
              child.once('close', () => resolve()),
            ),
        );
        for (const child of processes) {
          if (process.platform === 'win32' || !child.pid) child.kill('SIGKILL');
          else {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                throw error;
            }
          }
        }
        await Promise.all(exited);
        expect(processes.size).toBe(0);
        await vi.waitFor(
          async () => {
            const running = await runtime.repositories.asyncTasks.listTasks({
              appId: 'default',
              agentId: BACKGROUND_AGENT,
              statuses: ['queued', 'running'],
              limit: 100,
            });
            expect(running).toHaveLength(0);
          },
          { timeout: 10_000, interval: 10 },
        );
      } finally {
        configurePendingInteractionDurability(null);
        try {
          const capabilities = await mcpServers.materializeForAgent({
            appId: 'default' as never,
            agentId: BACKGROUND_AGENT as never,
            serverIds: [server.id],
          });
          await Promise.all(capabilities.map(closeCachedMcpClient));
        } finally {
          for (const spy of clientSpies) spy.mockRestore();
        }
      }
    },
  };
}
