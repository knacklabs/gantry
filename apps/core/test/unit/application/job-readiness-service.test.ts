import { describe, expect, it, vi } from 'vitest';

import {
  evaluateJobReadiness,
  setupStateForDeniedTool,
} from '@core/application/jobs/job-readiness-service.js';
import type {
  McpServerRepository,
  ToolCatalogRepository,
} from '@core/domain/ports/repositories.js';
import type { Job } from '@core/domain/types.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'Job',
    prompt: 'Run it',
    model: null,
    schedule_type: 'interval',
    schedule_value: '60000',
    status: 'active',
    session_id: null,
    thread_id: null,
    group_scope: 'agent-one',
    created_by: 'agent',
    created_at: '2026-05-14T00:00:00.000Z',
    updated_at: '2026-05-14T00:00:00.000Z',
    next_run: '2026-05-14T00:01:00.000Z',
    last_run: null,
    silent: false,
    cleanup_after_ms: 86400000,
    timeout_ms: 300000,
    max_retries: 3,
    retry_backoff_ms: 5000,
    max_consecutive_failures: 5,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    execution_context: {
      conversationJid: 'tg:team',
      threadId: null,
      groupScope: 'agent-one',
    },
    ...overrides,
  };
}

function toolRepository(rules: string[]): ToolCatalogRepository {
  return {
    listAgentToolBindings: vi.fn(async () =>
      rules.map((rule, index) => ({
        status: 'active',
        toolId: `tool:${index}`,
      })),
    ),
    getTool: vi.fn(async (toolId: string) => {
      const index = Number(toolId.replace('tool:', ''));
      return { appId: 'default', name: rules[index] };
    }),
  } as unknown as ToolCatalogRepository;
}

describe('job readiness service', () => {
  it('reports ready when declared requirements have durable bindings and browser state', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({ required_tools: ['Browser'] }),
      appId: 'default',
      toolRepository: toolRepository(['Browser']),
      getBrowserStatus: vi.fn(async () => ({ hasState: true })),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState).toMatchObject({
      state: 'ready',
      blockers: [],
    });
  });

  it('pauses for missing durable tool capabilities', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({ required_tools: ['Browser'] }),
      appId: 'default',
      toolRepository: toolRepository([]),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.pauseReason).toBe('Setup required');
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'missing_capability',
      requirementType: 'browser',
      requirementId: 'Browser',
    });
  });

  it('uses a conservative browser login blocker after durable Browser approval', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({ required_tools: ['Browser'] }),
      appId: 'default',
      toolRepository: toolRepository(['Browser']),
      getBrowserStatus: vi.fn(async () => ({ hasState: false })),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'browser_login_may_be_required',
      requirementType: 'browser',
    });
  });

  it('derives Browser profile from the runtime group folder, not canonical agent id', async () => {
    const getBrowserStatus = vi.fn(async () => ({ hasState: false }));

    const result = await evaluateJobReadiness({
      job: makeJob({
        group_scope: 'main_agent',
        required_tools: ['Browser'],
        execution_context: {
          conversationJid: 'tg:-1003986348737',
          threadId: null,
          groupScope: 'main_agent',
        },
      }),
      agentId: 'agent:main_agent',
      appId: 'default',
      toolRepository: toolRepository(['Browser']),
      getBrowserStatus,
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(getBrowserStatus).toHaveBeenCalledWith('c-main_agent-27f898a4e060');
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      'c-main_agent-27f898a4e060',
    );
    expect(result.setupState.blockers[0]?.nextAction).not.toContain(
      'c-agent-main_agent',
    );
  });

  it('blocks unknown semantic capabilities even when a stale tool rule exists', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({ required_tools: ['capability:unknown.tool'] }),
      appId: 'default',
      toolRepository: toolRepository(['capability:unknown.tool']),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'missing_capability',
      requirementType: 'semantic_capability',
      requirementId: 'unknown.tool',
    });
  });

  it('reports MCP credential blockers without starting the MCP server', async () => {
    const repository = {
      listMaterializedServersForAgent: vi.fn(async () => [
        {
          definition: {
            id: 'mcp:server-1',
            appId: 'default',
            name: 'sheets',
            status: 'approved',
          },
          version: {
            credentialRefs: [
              { name: 'GOOGLE_TOKEN_REF', target: 'env', key: 'TOKEN' },
            ],
          },
          binding: { status: 'active' },
        },
      ]),
    } as unknown as McpServerRepository;

    const result = await evaluateJobReadiness({
      job: makeJob({ required_mcp_servers: ['sheets'] }),
      appId: 'default',
      mcpServerRepository: repository,
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(repository.listMaterializedServersForAgent).toHaveBeenCalled();
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'mcp_missing_credential',
      requirementType: 'mcp_server',
      requirementId: 'sheets',
    });
  });

  it('turns runtime denied tool use into setup state', () => {
    const setup = setupStateForDeniedTool({
      toolName: 'mcp__myclaw__service_restart',
      recoveryAction: 'request_permission ...',
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup).toMatchObject({
      state: 'missing_capability',
      blockers: [
        {
          requirementType: 'tool',
          requirementId: 'mcp__myclaw__service_restart',
          nextAction: 'request_permission ...',
        },
      ],
    });
  });

  it('canonicalizes projected browser tool denials to Browser setup', () => {
    const setup = setupStateForDeniedTool({
      toolName: 'mcp__myclaw__browser_act',
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup.blockers[0]).toMatchObject({
      requirementType: 'browser',
      requirementId: 'Browser',
      nextAction: expect.stringContaining('"toolName":"Browser"'),
    });
  });
});
