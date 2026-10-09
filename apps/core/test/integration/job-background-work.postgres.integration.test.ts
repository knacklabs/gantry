import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PostgresIntegrationRuntime } from '../harness/postgres-integration-runtime.js';
import type { createJobBackgroundHarness } from '../harness/job-background-work.js';

// The model runner is the external edge; admission, dispatch and persistence run normally.
vi.mock('@core/runtime/agent-spawn.js', async (original) => ({
  ...(await original<typeof import('@core/runtime/agent-spawn.js')>()),
  spawnAgent: async () => ({
    status: 'success',
    result: 'Inline subagent finished.',
  }),
}));

const maybeDescribe = process.env.GANTRY_TEST_DATABASE_URL
  ? describe
  : describe.skip;

maybeDescribe('scheduled job background work (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let harness: Awaited<ReturnType<typeof createJobBackgroundHarness>>;
  let home: string;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-job-background-'));
    vi.stubEnv('GANTRY_HOME', home);
    vi.stubEnv(
      'SECRET_ENCRYPTION_KEY',
      Buffer.alloc(32, 31).toString('base64'),
    );
    vi.resetModules();
    const { createPostgresIntegrationRuntime } =
      await import('../harness/postgres-integration-runtime.js');
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'job_background_work',
    });
    const { createJobBackgroundHarness } =
      await import('../harness/job-background-work.js');
    harness = await createJobBackgroundHarness(runtime);
  }, 60_000);

  afterAll(async () => {
    try {
      try {
        await harness?.cleanup();
      } finally {
        await runtime?.cleanup();
      }
    } finally {
      vi.unstubAllEnvs();
      if (home) fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('completes a scheduled background command with its starting run and job and excludes another job', async () => {
    const run = await harness.dispatch(
      'job:background:command',
      async (input) => {
        const id = await harness.invoke(input, 'async_run_command', {
          command: 'printf command-finished',
        });
        expect(id).toBeTruthy();
        const task = await harness.waitForTask(id!);
        expect(task.outputSummary).toBe('command-finished');
        return task.outputSummary!;
      },
    );
    const other = await harness.dispatch(
      'job:background:other',
      async (input) => {
        const id = await harness.invoke(input, 'async_run_command', {
          command: 'printf other-finished',
        });
        return (await harness.waitForTask(id!)).outputSummary!;
      },
    );
    const rows = await harness.tasksForJob(run.job_id);
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'async_command',
        status: 'completed',
        parent_run_id: run.run_id,
        parent_job_id: run.job_id,
        output_summary: 'command-finished',
      }),
    ]);
    const otherRows = await harness.tasksForJob(other.job_id);
    expect(otherRows).toEqual([
      expect.objectContaining({
        parent_run_id: other.run_id,
        output_summary: 'other-finished',
      }),
    ]);
    expect(rows.map((row) => row.id)).not.toContain(otherRows[0]!.id);
  }, 30_000);

  it('completes a slow scheduled MCP call with its starting run and job', async () => {
    const run = await harness.dispatch('job:background:mcp', async (input) => {
      const id = await harness.invoke(input, 'async_mcp_call', {
        serverName: 'remote',
        toolName: 'report',
        arguments: {},
      });
      expect(id).toBeTruthy();
      await vi.waitFor(async () => {
        expect(
          await runtime.repositories.asyncTasks.getTask(id!),
        ).toMatchObject({ status: 'running' });
      });
      harness.releaseMcp();
      return (await harness.waitForTask(id!)).outputSummary!;
    });
    expect(await harness.tasksForJob(run.job_id)).toEqual([
      expect.objectContaining({
        kind: 'mcp_tool_call',
        status: 'completed',
        parent_run_id: run.run_id,
        parent_job_id: run.job_id,
        output_summary: expect.stringContaining('Remote tool finished.'),
      }),
    ]);
  });

  it('completes scheduled subagents through IPC and inline lanes with the starting run and job', async () => {
    const run = await harness.dispatch(
      'job:background:delegation',
      async (input) => {
        const ipcId = await harness.invoke(input, 'delegate_task', {
          objective: 'Finish IPC work',
        });
        await harness.waitForTask(ipcId!);
        const { createInlineAgentTaskLifecycle } =
          await import('@core/app/bootstrap/inline-agent-task-lifecycle.js');
        const { InMemoryInlineRunnerControlPort } =
          await import('@core/runtime/agent-inline.js');
        const lifecycle = createInlineAgentTaskLifecycle({
          laneInput: {
            group: harness.group,
            input: {
              ...input,
              compiledSystemPrompt: '',
              permissionMode: 'auto',
            },
            correlationRunId: input.runId,
            signal: new AbortController().signal,
            controlPort: new InMemoryInlineRunnerControlPort(),
            resolvedModel: {} as never,
            modelCredentialEnv: {},
            mcpServers: [],
            runtimeDataDir: home,
            jobActivity: {
              beginPermissionRequest() {},
              finishPermissionRequest() {},
            },
            emitOutput: async () => {},
          },
          repository: runtime.repositories.asyncTasks,
          getConversationRoutes: () => harness.routes,
          resolveExecutionProviderId: async () => 'anthropic:claude-agent-sdk',
          resolveRunAccess: async () => ({}),
          buildRunOptions: async () => ({
            runnerSandboxProvider: harness.sandbox,
          }),
        });
        const result = await lifecycle!.delegate_task({
          objective: 'Finish inline work',
        });
        expect(result).toMatchObject({ ok: true });
        const id = (result as { data: { id: string } }).data.id;
        await harness.waitForTask(id);
        return 'Both subagents finished.';
      },
    );
    const rows = await harness.tasksForJob(run.job_id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.output_summary).sort()).toEqual([
      'Inline subagent finished.',
      'Subagent finished.',
    ]);
    for (const row of rows)
      expect(row).toMatchObject({
        kind: 'delegated_agent',
        status: 'completed',
        parent_run_id: run.run_id,
        parent_job_id: run.job_id,
      });
  });

  it('keeps chat work without a job and job work without a run', async () => {
    const { BACKGROUND_FOLDER, BACKGROUND_AGENT, BACKGROUND_JID } =
      await import('../harness/job-background-work.js');
    const input = {
      prompt: 'Background work',
      appId: 'default',
      agentId: BACKGROUND_AGENT,
      workspaceFolder: BACKGROUND_FOLDER,
      chatJid: BACKGROUND_JID,
    };
    const context = await runtime.ops.getAgentTurnContext({
      appId: 'default',
      agentFolder: BACKGROUND_FOLDER,
      executionProviderId: 'anthropic:claude-agent-sdk',
      conversationJid: BACKGROUND_JID,
      hydrateMemory: false,
    });
    const chatRunId = await runtime.ops.createSessionAgentRun({
      agentSessionId: context.agentSessionId!,
      executionProviderId: 'anthropic:claude-agent-sdk',
      cause: 'manual',
    });
    const chatId = await harness.invoke(
      { ...input, runId: chatRunId },
      'async_run_command',
      { command: 'printf chat-finished' },
    );
    expect(await harness.waitForTask(chatId!)).toMatchObject({
      parentRunId: chatRunId,
      parentJobId: null,
    });
    await runtime.ops.completeSessionAgentRun({
      runId: chatRunId,
      status: 'completed',
      resultSummary: 'chat-finished',
    });
    await harness.saveJob('job:background:without-run');
    const jobId = await harness.invoke(
      { ...input, jobId: 'job:background:without-run' },
      'async_run_command',
      { command: 'printf job-only-finished' },
    );
    expect(await harness.waitForTask(jobId!)).toMatchObject({
      parentRunId: null,
      parentJobId: 'job:background:without-run',
    });
  }, 30_000);
});
