import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const previousIpcDir = process.env.GANTRY_IPC_DIR;
const previousChatJid = process.env.GANTRY_CHAT_JID;
const previousWorkspaceKey = process.env.GANTRY_WORKSPACE_KEY;
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
  if (previousWorkspaceKey === undefined) {
    delete process.env.GANTRY_WORKSPACE_KEY;
  } else {
    process.env.GANTRY_WORKSPACE_KEY = previousWorkspaceKey;
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

    expect(text).toContain('Opus 4.8');
    expect(text).toContain('opus-4.8 | Opus 4.8');
    expect(text).toContain('Kimi K2.6');
    expect(text).toContain('kimi-2.6 | Kimi K2.6');
    expect(text).toContain('Response family');
  });

  it('delegates scheduler_list_models rendering to the model catalog formatter', async () => {
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
    const formatModelCatalog = vi.fn(() => 'mocked model catalog output');
    vi.doMock('../../../../src/shared/model-catalog-format.js', () => ({
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
        workspace_key: 'team',
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
    expect(schemas.get('scheduler_update_job')?.workspace_key).toBeUndefined();
    expect(schemas.get('scheduler_update_job')?.thread_id).toBeUndefined();
    expect(schemas.get('scheduler_upsert_job')?.workspace_key).toBeUndefined();
    expect(schemas.get('scheduler_upsert_job')?.thread_id).toBeUndefined();
    expect(schemas.get('scheduler_list_jobs')?.workspace_key).toBeUndefined();
    expect(
      schemas.get('scheduler_list_jobs')?.conversation_jid,
    ).toBeUndefined();
    expect(schemas.get('scheduler_run_now')?.job_id).toBeDefined();
    expect(schemas.get('scheduler_grant_tool')).toBeUndefined();
    expect(schemas.get('scheduler_upsert_job')?.allowed_tools).toBeUndefined();
    expect(
      schemas
        .get('scheduler_upsert_job')
        ?.access_requirements.safeParse([
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ]).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_upsert_job')?.access_requirements.safeParse([
        {
          target: {
            kind: 'capability',
            capability_id: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executable_path: '/usr/local/bin/acme',
              executable_version: 'v0.9.0',
              executable_hash: 'sha256:abc123',
              command_template: '/usr/local/bin/acme records append *',
              auth_preflight: '/usr/local/bin/acme auth status',
              protected_paths: ['~/.config/acme/*'],
            },
          },
          reason: 'Write lead rows after each run',
        },
      ]).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_upsert_job')?.access_requirements.safeParse([
        {
          target: {
            kind: 'capability',
            capability_id: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executable_path: '/usr/local/bin/acme',
              command_template: 'acme records append *',
            },
          },
          reason: 'Write lead rows after each run',
        },
      ]).success,
    ).toBe(false);
    expect(
      schemas.get('scheduler_upsert_job')?.access_requirements.safeParse([
        {
          target: {
            kind: 'capability',
            capability_id: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executable_path: '/usr/local/bin/acme',
              command_template: '/usr/local/bin/acme records append *',
              auth_preflight: 'acme auth status',
            },
          },
          reason: 'Write lead rows after each run',
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
        ?.access_requirements.safeParse([
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ]).success,
    ).toBe(true);
    expect(
      schemas.get('scheduler_update_job')?.access_requirements.safeParse([
        {
          target: {
            kind: 'capability',
            capability_id: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executable_path: '/usr/local/bin/acme',
              executable_version: 'v0.9.0',
              executable_hash: 'sha256:abc123',
              command_template: '/usr/local/bin/acme records append *',
              auth_preflight: '/usr/local/bin/acme auth status',
              protected_paths: ['~/.config/acme/*'],
            },
          },
          reason: 'Write lead rows after each run',
        },
      ]).success,
    ).toBe(true);
    expect(schemas.get('scheduler_list_notification_targets')).toBeDefined();
  });

  it('rejects removed execution_context group scope fields through the MCP schema parse path', async () => {
    // Guards the real MCP parse path: the SDK runs the per-tool zod schema and
    // strips unknown keys before the handler, so the rejection must come from
    // the execution_context schema (passthrough + superRefine), not the handler.
    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-tools-'));
    tempRoots.push(ipcDir);
    process.env.GANTRY_IPC_DIR = ipcDir;
    const { registerSchedulerTools } =
      await import('../../../../src/runner/mcp/tools/scheduler.js');
    const schemas = new Map<
      string,
      Record<
        string,
        {
          safeParse: (input: unknown) => {
            success: boolean;
            error?: { issues: { message: string }[] };
          };
        }
      >
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        schema: Record<
          string,
          {
            safeParse: (input: unknown) => {
              success: boolean;
              error?: { issues: { message: string }[] };
            };
          }
        >,
      ) => {
        schemas.set(name, schema);
      },
    };

    registerSchedulerTools(server as never);

    for (const removedField of ['group_scope', 'groupScope'] as const) {
      const result = schemas
        .get('scheduler_upsert_job')!
        .execution_context.safeParse({
          conversation_jid: 'tg:team',
          thread_id: null,
          workspace_key: 'team',
          [removedField]: 'team',
        });

      expect(result.success).toBe(false);
      expect(result.error!.issues.map((issue) => issue.message)).toContain(
        'group_scope/groupScope is no longer accepted. Use workspace_key.',
      );
    }
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
        workspace_key: 'team',
      },
      access_requirements: [
        {
          target: {
            kind: 'capability',
            capability_id: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executable_path: '/usr/local/bin/acme',
              executable_version: 'v0.9.0',
              executable_hash: 'sha256:abc123',
              command_template: '/usr/local/bin/acme records append *',
            },
          },
          reason: 'Write lead rows after each run',
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
          workspaceKey: 'team',
        },
        accessRequirements: [
          {
            target: {
              kind: 'capability',
              capabilityId: 'acme.records.append',
              implementation: {
                kind: 'local_cli',
                name: 'acme',
                executablePath: '/usr/local/bin/acme',
                executableVersion: 'v0.9.0',
                executableHash: 'sha256:abc123',
                commandTemplate: '/usr/local/bin/acme records append *',
              },
            },
            reason: 'Write lead rows after each run',
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
    process.env.GANTRY_WORKSPACE_KEY = 'team';
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
      access_requirements: [
        {
          target: {
            kind: 'capability',
            capability_id: 'acme.records.append',
            implementation: {
              kind: 'local_cli',
              name: 'acme',
              executable_path: '/usr/local/bin/acme',
              executable_version: 'v0.9.0',
              executable_hash: 'sha256:abc123',
              command_template: '/usr/local/bin/acme records append *',
            },
          },
          reason: 'Write lead rows after each run',
        },
        { target: { kind: 'tool_rule', rule: 'Browser' } },
      ],
    });

    expect(response.isError).not.toBe(true);
    expect(response.content[0].text).toContain('Scheduler job plan');
    expect(response.content[0].text).toContain('- Schedule: once');
    expect(response.content[0].text).toContain('- Model: job default');
    expect(response.content[0].text).toContain(
      '- Access requirements: capabilities Acme Records Append using acme; tools Browser',
    );
    expect(response.content[0].text).toContain(
      'use capability:<id> for reviewed semantic access',
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
    process.env.GANTRY_WORKSPACE_KEY = 'team';
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
        workspaceKey: 'team',
      },
      notificationRoutes: [
        {
          conversationJid: 'tg:team',
          threadId: null,
          label: 'primary',
        },
      ],
      accessRequirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
      createdBy: 'agent',
    });
    const response = await tools.get('scheduler_upsert_job')!({
      name: 'Nightly',
      prompt: 'Summarize',
      schedule_type: 'once',
      schedule_value: '2026-05-04T00:00:00.000Z',
      target: 'here',
      access_requirements: [{ target: { kind: 'tool_rule', rule: 'Browser' } }],
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
          workspaceKey: 'team',
        },
        notificationRoutes: [
          {
            conversationJid: 'tg:team',
            threadId: null,
            label: 'primary',
          },
        ],
        accessRequirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
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
      'required_tools is no longer accepted. Use access_requirements',
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
            nextAction:
              'request_access { "target": { "kind": "capability", "id": "browser.use" } }',
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
        prompt: 'Send a short customer follow-up every morning.',
        schedule_type: 'once',
        status: 'active',
        visibility: {
          target: { agentId: 'agent:main', conversationJids: ['tg:team'] },
          recentRunErrors: [],
        },
      }),
    ).toContain('Tool access: missing canonical toolAccess');
    expect(
      schedulerJobSummary({
        id: 'job-1',
        name: 'Follow up',
        prompt: 'Send a short customer follow-up every morning.',
        schedule_type: 'once',
        status: 'active',
        visibility: {
          target: { agentId: 'agent:main', conversationJids: ['tg:team'] },
          recentRunErrors: [],
        },
      }),
    ).toContain('Prompt: Send a short customer follow-up every morning.');
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
    ).toContain(
      '- job-1 | Follow up | Ready | Workspace: unknown | Agent: agent:main | Next: none',
    );
    expect(
      schedulerJobSummary({
        id: 'job-2',
        name: 'Use browser when needed',
        access_requirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
        visibility: {
          executionContext: { conversationJid: 'tg:team' },
          toolAccess: {
            effectiveAllowedTools: ['Browser'],
            inheritedAgentTools: ['Browser'],
            projectedRuntimeTools: ['Browser'],
          },
        },
      }),
    ).toContain('Access requirements: tools Browser');
    const semanticSummary = schedulerJobSummary({
      id: 'job-3',
      name: 'Append reviewed records',
      access_requirements: [
        {
          target: {
            kind: 'capability',
            capabilityId: 'acme.records.append',
          },
        },
      ],
      visibility: {
        executionContext: { conversationJid: 'tg:team' },
        toolAccess: {
          effectiveAllowedTools: ['capability:acme.records.append'],
          inheritedAgentTools: ['capability:acme.records.append'],
          projectedRuntimeTools: ['acme.records.append'],
        },
      },
    });
    expect(semanticSummary).toContain(
      'Access requirements: capabilities acme.records.append',
    );
    expect(semanticSummary).not.toContain(
      'tools capability:acme.records.append',
    );
  });

  it('renders notification targets with shortcut and routing values', async () => {
    const { schedulerNotificationTargetsSummary } =
      await import('../../../../src/runner/mcp/tools/scheduler-formatters.js');

    const summary = schedulerNotificationTargetsSummary([
      {
        shortcut: 'here',
        label: 'Current conversation',
        executionContext: {
          conversationJid: 'tg:team',
          threadId: null,
          workspaceKey: 'team',
        },
        notificationRoutes: [
          {
            conversationJid: 'tg:team',
            threadId: null,
            label: 'primary',
          },
        ],
      },
    ]);

    expect(summary).toContain('Scheduler notification targets (1)');
    expect(summary).toContain('- here | Current conversation');
    expect(summary).toContain(
      'execution_context conversation_jid=tg:team thread_id=none workspace_key=team',
    );
    expect(summary).toContain('notification_routes 1 (primary:tg:team:none)');
    expect(summary).not.toContain('Scheduler events');
  });

  it('renders compact scheduler job list rows in workspace/access language', async () => {
    const { schedulerJobsSummary } =
      await import('../../../../src/runner/mcp/tools/scheduler-formatters.js');

    const summary = schedulerJobsSummary([
      {
        id: 'job-2',
        name: 'Use browser when needed',
        workspace_key: 'personal',
        access_requirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
        visibility: {
          executionContext: {
            conversationJid: 'tg:team',
            workspaceKey: 'team-space',
          },
          target: { agentId: 'agent:main', conversationJids: ['tg:team'] },
          setup: {
            state: 'missing_capability',
            blockers: [
              {
                state: 'missing_capability',
                requirementType: 'browser',
                requirementId: 'browser.use',
              },
            ],
          },
          toolAccess: {
            effectiveAllowedTools: ['Browser'],
            inheritedAgentTools: ['Browser'],
            projectedRuntimeTools: ['Browser'],
          },
        },
      },
    ]);

    expect(summary).toContain(
      '- job-2 | Use browser when needed | Needs approval | Workspace: team-space | Agent: agent:main | Next: Approve Browser access, then resume the job.',
    );
    expect(summary).not.toContain('capabilities:');
    expect(summary).not.toContain('access:');
    expect(summary).not.toContain('mcp:');
    expect(summary).not.toContain('tools:');
  });

  it('renders provider-neutral workspace and agent labels in the scheduler list line', async () => {
    const { schedulerJobsSummary } =
      await import('../../../../src/runner/mcp/tools/scheduler-formatters.js');

    const summary = schedulerJobsSummary([
      {
        id: 'job-1',
        name: 'Topic digest',
        status: 'active',
        visibility: {
          executionContext: {
            conversationJid: 'tg:-100team',
            threadId: '42',
            workspaceKey: 'telegram-team',
          },
          target: { agentId: 'agent:main', conversationJids: ['tg:-100team'] },
        },
      },
    ]);
    const listLine = summary
      .split('\n')
      .find((line) => line.startsWith('- job-1'));
    expect(listLine).toContain('Workspace: telegram-team');
    expect(listLine).toContain('Agent: agent:main');
    expect(listLine).not.toContain('tg:-100team');
  });

  it('renders provider-neutral owner/delivery labels and setup status', async () => {
    const { schedulerJobSummary } =
      await import('../../../../src/runner/mcp/tools/scheduler-formatters.js');

    const telegramTopic = schedulerJobSummary({
      id: 'job-1',
      name: 'Topic digest',
      status: 'active',
      visibility: {
        executionContext: { conversationJid: 'tg:-100team', threadId: '42' },
        notificationRoutes: [
          { conversationJid: 'tg:-100team', threadId: '42', label: 'primary' },
        ],
        target: { agentId: 'agent:main', conversationJids: ['tg:-100team'] },
        recentRunErrors: [],
      },
    });
    expect(telegramTopic).toContain('Owned by: Telegram group');
    expect(telegramTopic).toContain('Delivers to: Telegram topic');

    const slackThread = schedulerJobSummary({
      id: 'job-2',
      name: 'Thread digest',
      status: 'active',
      visibility: {
        executionContext: { conversationJid: 'sl:C0001', threadId: '123.45' },
        notificationRoutes: [
          { conversationJid: 'sl:C0001', threadId: '123.45', label: 'primary' },
        ],
        recentRunErrors: [],
      },
    });
    expect(slackThread).toContain('Owned by: Slack channel');
    expect(slackThread).toContain('Delivers to: Slack thread');

    const wholeConversation = schedulerJobSummary({
      id: 'job-3',
      name: 'Conversation digest',
      status: 'active',
      visibility: {
        executionContext: { conversationJid: 'tg:-100team', threadId: null },
        notificationRoutes: [
          { conversationJid: 'tg:-100team', threadId: null, label: 'primary' },
        ],
        recentRunErrors: [],
      },
    });
    expect(wholeConversation).toContain('Delivers to: Telegram group');
    expect(wholeConversation).not.toContain('Delivers to: Telegram topic');

    const missingCapability = schedulerJobSummary({
      id: 'job-4',
      name: 'Append records',
      status: 'paused',
      visibility: {
        executionContext: { conversationJid: 'tg:-100team', threadId: null },
        setup: {
          state: 'missing_capability',
          blockers: [
            {
              state: 'missing_capability',
              requirementType: 'semantic_capability',
              requirementId: 'acme.records.append',
              nextAction: '',
            },
          ],
        },
        recentRunErrors: [],
      },
    });
    expect(missingCapability).toContain('Setup: Needs approval');
    expect(missingCapability).toContain(
      'Next action: Approve Acme Records Append, then resume the job.',
    );
  });
});
