import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const previousIpcDir = process.env.MYCLAW_IPC_DIR;
const tempRoots: string[] = [];

afterEach(() => {
  vi.resetModules();
  if (previousIpcDir === undefined) {
    delete process.env.MYCLAW_IPC_DIR;
  } else {
    process.env.MYCLAW_IPC_DIR = previousIpcDir;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('scheduler MCP tools', () => {
  it('exposes supported job model aliases through scheduler_list_models', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-tools-'));
    tempRoots.push(ipcDir);
    process.env.MYCLAW_IPC_DIR = ipcDir;
    const { registerSchedulerTools } =
      await import('../../../../src/runner/mcp/tools/scheduler.js');
    const tools = new Map<
      string,
      () => Promise<{ content: { text: string }[] }>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: never,
      ) => {
        tools.set(name, handler);
      },
    };

    registerSchedulerTools(server as never);

    expect(tools.has('list_models')).toBe(false);
    const response = await tools.get('scheduler_list_models')!();
    const text = response.content[0].text;

    expect(text).toContain('Opus 4.7');
    expect(text).toContain('use "opus", "opus-4.7"');
    expect(text).toContain('Kimi K2.6');
    expect(text).toContain('use "kimi", "kimi-k2.6"');
  });

  it('delegates scheduler_list_models rendering to the model catalog formatter', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-tools-'));
    tempRoots.push(ipcDir);
    process.env.MYCLAW_IPC_DIR = ipcDir;
    const formatModelCatalog = vi.fn(() => 'mocked model catalog output');
    vi.doMock('../../../../src/shared/model-catalog.js', () => ({
      formatModelCatalog,
    }));
    const { registerSchedulerTools } =
      await import('../../../../src/runner/mcp/tools/scheduler.js');

    const tools = new Map<
      string,
      () => Promise<{ content: { text: string }[] }>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: never,
      ) => {
        tools.set(name, handler);
      },
    };

    registerSchedulerTools(server as never);

    const response = await tools.get('scheduler_list_models')!();
    expect(formatModelCatalog).toHaveBeenCalledTimes(1);
    expect(response.content[0].text).toBe('mocked model catalog output');
  });

  it('allows scheduler_update_job to clear explicit model selection', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-tools-'));
    tempRoots.push(ipcDir);
    process.env.MYCLAW_IPC_DIR = ipcDir;
    const { registerSchedulerTools } =
      await import('../../../../src/runner/mcp/tools/scheduler.js');
    const schemas = new Map<
      string,
      Record<string, { safeParse: (input: unknown) => { success: boolean } }>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        schema: Record<
          string,
          { safeParse: (input: unknown) => { success: boolean } }
        >,
      ) => {
        schemas.set(name, schema);
      },
    };

    registerSchedulerTools(server as never);

    expect(
      schemas.get('scheduler_update_job')?.model_alias.safeParse(null).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_update_job')?.model_profile_id.safeParse(null)
        .success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_update_job')?.execution_context.safeParse({
        conversation_jid: 'tg:team',
        thread_id: null,
        group_scope: 'team',
      }).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_update_job')?.notification_routes.safeParse([
        {
          conversation_jid: 'tg:team',
          thread_id: null,
          label: 'primary',
        },
      ]).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_update_job')?.target.safeParse('here').success,
    ).toBe(true);
    expect(schemas.get('scheduler_list_jobs')?.group_scope).toBeUndefined();
    expect(
      schemas.get('scheduler_list_jobs')?.conversation_jid,
    ).toBeUndefined();
    expect(schemas.get('scheduler_run_now')?.job_id).toBeDefined();
    expect(schemas.get('scheduler_list_notification_targets')).toBeDefined();
  });

  it('passes five-minute scheduler event waits through to host IPC', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-tools-'));
    tempRoots.push(ipcDir);
    process.env.MYCLAW_IPC_DIR = ipcDir;
    const waitForTaskResponse = vi.fn(async () => ({
      ok: true,
      data: { events: [] },
    }));
    const writeIpcFile = vi.fn();
    vi.doMock('../../../../src/runner/mcp/ipc.js', () => ({
      waitForTaskResponse,
      writeIpcFile,
    }));
    const { registerSchedulerTools } =
      await import('../../../../src/runner/mcp/tools/scheduler.js');
    const tools = new Map<
      string,
      (
        args: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[] }>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: never,
      ) => {
        tools.set(name, handler);
      },
    };

    registerSchedulerTools(server as never);

    const response = await tools.get('scheduler_wait_for_events')!({
      job_id: 'job-1',
      timeout_ms: 300_000,
    });

    expect(response.content[0].text).toBe('[]');
    expect(writeIpcFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'scheduler_wait_for_events',
        jobId: 'job-1',
        timeoutMs: 300_000,
      }),
    );
    expect(waitForTaskResponse).toHaveBeenCalledWith(
      expect.any(String),
      310_000,
    );
  });

  it('writes canonical executionContext and notificationRoutes for target shortcuts', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-tools-'));
    tempRoots.push(ipcDir);
    process.env.MYCLAW_IPC_DIR = ipcDir;
    process.env.MYCLAW_CHAT_JID = 'tg:team';
    process.env.MYCLAW_GROUP_FOLDER = 'team';
    const waitForTaskResponse = vi.fn(async () => ({ ok: true }));
    const writeIpcFile = vi.fn();
    vi.doMock('../../../../src/runner/mcp/ipc.js', () => ({
      waitForTaskResponse,
      writeIpcFile,
    }));
    const { registerSchedulerTools } =
      await import('../../../../src/runner/mcp/tools/scheduler.js');
    const tools = new Map<
      string,
      (
        args: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[]; isError?: boolean }>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: never,
      ) => {
        tools.set(name, handler);
      },
    };

    registerSchedulerTools(server as never);
    const response = await tools.get('scheduler_upsert_job')!({
      name: 'Nightly',
      prompt: 'Summarize',
      schedule_type: 'once',
      schedule_value: '2026-05-04T00:00:00.000Z',
      target: 'here',
    });

    expect(response.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'scheduler_upsert_job',
        executionContext: {
          conversationJid: 'tg:team',
          threadId: null,
          groupScope: 'team',
        },
        notificationRoutes: [
          {
            conversationJid: 'tg:team',
            threadId: null,
            label: 'primary',
          },
        ],
      }),
    );
  });

  it('rejects legacy scheduler fields in scheduler_update_job tool calls', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-tools-'));
    tempRoots.push(ipcDir);
    process.env.MYCLAW_IPC_DIR = ipcDir;
    const { registerSchedulerTools } =
      await import('../../../../src/runner/mcp/tools/scheduler.js');
    const tools = new Map<
      string,
      (
        args: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[]; isError?: boolean }>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: never,
      ) => {
        tools.set(name, handler);
      },
    };

    registerSchedulerTools(server as never);
    const response = await tools.get('scheduler_update_job')!({
      job_id: 'job-1',
      deliver_to: ['tg:team'],
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain(
      'Unsupported legacy scheduler field "deliver_to"',
    );
  });

  it('renders missed-window staleness in scheduler job summaries', async () => {
    const { schedulerJobSummary } =
      await import('../../../../src/runner/mcp/tools/scheduler-formatters.js');

    expect(
      schedulerJobSummary({
        id: 'job-1',
        name: 'Follow up',
        schedule_type: 'once',
        status: 'active',
        next_run: '2026-04-24T09:00:00.000Z',
        last_run: null,
        visibility: {
          staleness: 'missed_window',
          target: { agentId: 'agent:main', conversationJids: ['tg:team'] },
          toolAccess: {
            inheritedAgentTools: [],
            jobExtraTools: [],
            effectiveAllowedTools: [],
          },
          recentRunErrors: [],
        },
      }),
    ).toContain('Staleness: missed_window');
  });

  it('does not hide missing canonical toolAccess in scheduler summaries', async () => {
    const { schedulerJobSummary, schedulerJobsSummary } =
      await import('../../../../src/runner/mcp/tools/scheduler-formatters.js');

    expect(
      schedulerJobSummary({
        id: 'job-1',
        name: 'Follow up',
        schedule_type: 'once',
        status: 'active',
        visibility: {
          target: { agentId: 'agent:main', conversationJids: ['tg:team'] },
          recentRunErrors: [],
        },
      }),
    ).toContain('Tool access: missing canonical toolAccess');
    expect(
      schedulerJobsSummary([
        {
          id: 'job-1',
          name: 'Follow up',
          schedule_type: 'once',
          status: 'active',
          visibility: {
            target: { agentId: 'agent:main', conversationJids: ['tg:team'] },
          },
        },
      ]),
    ).toContain('tools: (missing toolAccess)');
  });
});
