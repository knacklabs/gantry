import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const previousIpcDir = process.env.GANTRY_IPC_DIR;
const previousChatJid = process.env.GANTRY_CHAT_JID;
const previousGroupFolder = process.env.GANTRY_GROUP_FOLDER;
const tempRoots: string[] = [];

afterEach(() => {
  vi.resetModules();
  if (previousIpcDir === undefined) {
    delete process.env.GANTRY_IPC_DIR;
  } else {
    process.env.GANTRY_IPC_DIR = previousIpcDir;
  }
  if (previousChatJid === undefined) {
    delete process.env.GANTRY_CHAT_JID;
  } else {
    process.env.GANTRY_CHAT_JID = previousChatJid;
  }
  if (previousGroupFolder === undefined) {
    delete process.env.GANTRY_GROUP_FOLDER;
  } else {
    process.env.GANTRY_GROUP_FOLDER = previousGroupFolder;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('scheduler MCP tools', () => {
  it('exposes supported job model aliases through scheduler_list_models', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
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
    expect(text).toContain('opus-4.7 | Opus 4.7');
    expect(text).toContain('Kimi K2.6');
    expect(text).toContain('kimi-2.6 | Kimi K2.6');
    expect(text).toContain('Provider slug');
  });

  it('delegates scheduler_list_models rendering to the model catalog formatter', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
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
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
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
      schemas.get('scheduler_update_job')?.model_profile_id,
    ).toBeUndefined();
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
    expect(schemas.get('scheduler_update_job')?.group_scope).toBeUndefined();
    expect(schemas.get('scheduler_update_job')?.thread_id).toBeUndefined();
    expect(schemas.get('scheduler_upsert_job')?.group_scope).toBeUndefined();
    expect(schemas.get('scheduler_upsert_job')?.thread_id).toBeUndefined();
    expect(schemas.get('scheduler_list_jobs')?.group_scope).toBeUndefined();
    expect(
      schemas.get('scheduler_list_jobs')?.conversation_jid,
    ).toBeUndefined();
    expect(schemas.get('scheduler_run_now')?.job_id).toBeDefined();
    expect(schemas.get('scheduler_grant_tool')).toBeUndefined();
    expect(schemas.get('scheduler_upsert_job')?.allowed_tools).toBeUndefined();
    expect(
      schemas
        .get('scheduler_upsert_job')
        ?.tool_access_requirements.safeParse(['Browser']).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_upsert_job')?.capability_requirements.safeParse([
        {
          capability_id: 'google.sheets.write',
          reason: 'Write lead rows after each run',
          implementation: {
            kind: 'local_cli',
            name: 'gog',
            executable_path: '/usr/local/bin/gog',
            executable_version: 'v0.9.0',
            executable_hash: 'sha256:abc123',
            command_template: '/usr/local/bin/gog sheets append *',
            auth_preflight: '/usr/local/bin/gog auth status',
            protected_paths: ['~/.config/gog/*'],
          },
        },
      ]).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_upsert_job')?.capability_requirements.safeParse([
        {
          capability_id: 'google.sheets.write',
          reason: 'Write lead rows after each run',
          implementation: {
            kind: 'local_cli',
            name: 'gog',
            executable_path: '/usr/local/bin/gog',
            command_template: 'gog sheets append *',
          },
        },
      ]).success,
    ).toBe(false);
    expect(
      schemas.get('scheduler_upsert_job')?.capability_requirements.safeParse([
        {
          capability_id: 'google.sheets.write',
          reason: 'Write lead rows after each run',
          implementation: {
            kind: 'local_cli',
            name: 'gog',
            executable_path: '/usr/local/bin/gog',
            command_template: '/usr/local/bin/gog sheets append *',
            auth_preflight: 'gog auth status',
          },
        },
      ]).success,
    ).toBe(false);
    expect(schemas.get('scheduler_upsert_job')?.confirm).toBeDefined();
    expect(
      schemas.get('scheduler_upsert_job')?.confirmation_token,
    ).toBeDefined();
    expect(schemas.get('scheduler_update_job')?.allowed_tools).toBeUndefined();
    expect(
      schemas
        .get('scheduler_update_job')
        ?.tool_access_requirements.safeParse(['Browser']).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_update_job')?.capability_requirements.safeParse([
        {
          capability_id: 'google.sheets.write',
          reason: 'Write lead rows after each run',
          implementation: {
            kind: 'local_cli',
            name: 'gog',
            executable_path: '/usr/local/bin/gog',
            executable_version: 'v0.9.0',
            executable_hash: 'sha256:abc123',
            command_template: '/usr/local/bin/gog sheets append *',
            auth_preflight: '/usr/local/bin/gog auth status',
            protected_paths: ['~/.config/gog/*'],
          },
        },
      ]).success,
    ).toBe(true);
    expect(schemas.get('scheduler_list_notification_targets')).toBeDefined();
  });

  it('writes scheduler capability requirements for update mutations', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
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
    const response = await tools.get('scheduler_update_job')!({
      job_id: 'job-1',
      execution_context: {
        conversation_jid: 'tg:team',
        thread_id: null,
        group_scope: 'team',
      },
      capability_requirements: [
        {
          capability_id: 'google.sheets.write',
          reason: 'Write lead rows after each run',
          implementation: {
            kind: 'local_cli',
            name: 'gog',
            executable_path: '/usr/local/bin/gog',
            executable_version: 'v0.9.0',
            executable_hash: 'sha256:abc123',
            command_template: '/usr/local/bin/gog sheets append *',
          },
        },
      ],
    });

    expect(response.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'scheduler_update_job',
        jobId: 'job-1',
        executionContext: {
          conversationJid: 'tg:team',
          threadId: null,
          groupScope: 'team',
        },
        capabilityRequirements: [
          {
            capabilityId: 'google.sheets.write',
            reason: 'Write lead rows after each run',
            implementation: {
              kind: 'local_cli',
              name: 'gog',
              executablePath: '/usr/local/bin/gog',
              executableVersion: 'v0.9.0',
              executableHash: 'sha256:abc123',
              commandTemplate: '/usr/local/bin/gog sheets append *',
            },
          },
        ],
      }),
    );
  });

  it('passes five-minute scheduler event waits through to host IPC', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
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

    expect(response.content[0].text).toContain('Scheduler events (0)');
    expect(response.content[0].text).toContain('[]');
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

  it('returns an explain-before-confirm scheduler upsert plan without writing IPC', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
    process.env.GANTRY_CHAT_JID = 'tg:team';
    process.env.GANTRY_GROUP_FOLDER = 'team';
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
      capability_requirements: [
        {
          capability_id: 'google.sheets.write',
          reason: 'Write lead rows after each run',
          implementation: {
            kind: 'local_cli',
            name: 'gog',
            executable_path: '/usr/local/bin/gog',
            executable_version: 'v0.9.0',
            executable_hash: 'sha256:abc123',
            command_template: '/usr/local/bin/gog sheets append *',
          },
        },
      ],
      tool_access_requirements: ['Browser'],
    });

    expect(response.isError).not.toBe(true);
    expect(response.content[0].text).toContain('Scheduler job plan');
    expect(response.content[0].text).toContain('- Schedule: once');
    expect(response.content[0].text).toContain('- Model: job default');
    expect(response.content[0].text).toContain('- Tool access:');
    expect(response.content[0].text).toContain(
      '- Required capabilities: Google Sheets write using gog',
    );
    expect(response.content[0].text).toContain(
      '- Tool access requirements: Browser',
    );
    expect(response.content[0].text).toContain(
      'tool access requirements are preflight checks only',
    );
    expect(response.content[0].text).toContain('- Network:');
    expect(response.content[0].text).toContain('- Memory:');
    expect(response.content[0].text).toContain('- Runtime:');
    expect(response.content[0].text).toContain('Confirmation token:');
    expect(writeIpcFile).not.toHaveBeenCalled();
  });

  it('writes canonical executionContext and notificationRoutes for confirmed target shortcuts', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
    process.env.GANTRY_CHAT_JID = 'tg:team';
    process.env.GANTRY_GROUP_FOLDER = 'team';
    const waitForTaskResponse = vi.fn(async () => ({ ok: true }));
    const writeIpcFile = vi.fn();
    vi.doMock('../../../../src/runner/mcp/ipc.js', () => ({
      waitForTaskResponse,
      writeIpcFile,
    }));
    const { registerSchedulerTools } =
      await import('../../../../src/runner/mcp/tools/scheduler.js');
    const { schedulerJobConfirmationToken } =
      await import('../../../../src/jobs/job-plan-formatter.js');
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
    const confirmationToken = schedulerJobConfirmationToken({
      name: 'Nightly',
      prompt: 'Summarize',
      scheduleType: 'once',
      scheduleValue: '2026-05-04T00:00:00.000Z',
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
      toolAccessRequirements: ['Browser'],
      createdBy: 'agent',
    });
    const response = await tools.get('scheduler_upsert_job')!({
      name: 'Nightly',
      prompt: 'Summarize',
      schedule_type: 'once',
      schedule_value: '2026-05-04T00:00:00.000Z',
      target: 'here',
      tool_access_requirements: ['Browser'],
      confirm: true,
      confirmation_token: confirmationToken,
    });

    expect(response.isError).not.toBe(true);
    expect(writeIpcFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'scheduler_upsert_job',
        confirm: true,
        confirmationToken,
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
        toolAccessRequirements: ['Browser'],
      }),
    );
  });

  it('rejects unsupported scheduler mutation fields before writing IPC tasks', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
    const writeIpcFile = vi.fn();
    vi.doMock('../../../../src/runner/mcp/ipc.js', () => ({
      waitForTaskResponse: vi.fn(),
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
    const response = await tools.get('scheduler_update_job')!({
      job_id: 'job-1',
      deliver_to: ['tg:team'],
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain(
      'Unsupported scheduler fields: deliver_to',
    );
    expect(writeIpcFile).not.toHaveBeenCalled();
  });

  it('rejects deprecated scheduler required_tools input with cutover guidance', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
    const writeIpcFile = vi.fn();
    vi.doMock('../../../../src/runner/mcp/ipc.js', () => ({
      waitForTaskResponse: vi.fn(),
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
    const response = await tools.get('scheduler_update_job')!({
      job_id: 'job-1',
      required_tools: ['Browser'],
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain(
      'required_tools is no longer accepted. Use tool_access_requirements',
    );
    expect(writeIpcFile).not.toHaveBeenCalled();
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
            effectiveAllowedTools: [],
            projectedRuntimeTools: [],
          },
          health: {
            state: 'missed_window',
            latestRunStatus: null,
            nextAction: 'Run the job now or update its schedule.',
          },
          recentRunErrors: [],
        },
      }),
    ).toContain('Staleness: missed_window');
    expect(
      schedulerJobSummary({
        id: 'job-1',
        name: 'Follow up',
        schedule_type: 'once',
        status: 'active',
        visibility: {
          staleness: 'missed_window',
          target: { agentId: 'agent:main', conversationJids: ['tg:team'] },
          toolAccess: {
            inheritedAgentTools: ['Browser'],
            effectiveAllowedTools: ['Browser'],
            projectedRuntimeTools: ['mcp__gantry__browser_act'],
          },
          health: {
            state: 'needs_permission',
            latestRunStatus: 'dead_lettered',
            nextAction: 'request_permission { "toolName": "Browser" }',
          },
          recentRunErrors: [],
        },
      }),
    ).toContain(
      'Health: needs_permission | latest dead_lettered | action Approve Browser access, then resume the job.',
    );
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
    expect(
      schedulerJobsSummary([
        {
          id: 'job-2',
          name: 'Use browser when needed',
          tool_access_requirements: ['Browser'],
          visibility: {
            executionContext: { conversationJid: 'tg:team' },
            toolAccess: {
              effectiveAllowedTools: ['Browser'],
              inheritedAgentTools: ['Browser'],
              projectedRuntimeTools: ['Browser'],
            },
          },
        },
      ]),
    ).toContain('access: Browser');
  });
});
