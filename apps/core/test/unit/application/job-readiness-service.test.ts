import { describe, expect, it, vi } from 'vitest';

import {
  evaluateJobReadiness,
  setupStateForDeniedTool,
  setupStateForTransientPermission,
} from '@core/application/jobs/job-readiness-service.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '@core/domain/ports/repositories.js';
import type { AppId } from '@core/domain/app/app.js';
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

function skillActionToolRepository(): ToolCatalogRepository {
  return {
    listAgentToolBindings: vi.fn(async () => [
      {
        status: 'active',
        toolId: 'tool:capability:skill.linkedin-posting.publish',
      },
    ]),
    getTool: vi.fn(async () => ({
      appId: 'default',
      name: 'capability:skill.linkedin-posting.publish',
      inputSchema: {
        format: 'gantry.semantic-capability.v1',
        schema: {
          capabilityId: 'skill.linkedin-posting.publish',
          displayName: 'LinkedIn posting',
          category: 'linkedin-posting',
          risk: 'write',
          can: 'Publish a prepared LinkedIn post.',
          cannot: 'Read unrelated credentials.',
          credentialSource: 'skill_secret',
          implementationBindings: [
            {
              kind: 'tool_rule',
              rule: 'RunCommand(skills/linkedin-posting/post.py *)',
            },
          ],
          source: {
            kind: 'skill_action',
            skillId: 'skill:linkedin-posting',
            skillName: 'linkedin-posting',
            skillVersion: 'abc123',
            skillContentHash: 'sha256:abc123',
            actionId: 'publish',
          },
        },
      },
    })),
  } as unknown as ToolCatalogRepository;
}

function selectedLinkedInSkillRepository(
  contentHash = 'sha256:abc123',
): SkillCatalogRepository {
  return {
    listEnabledSkillsForAgent: vi.fn(async () => [
      {
        id: 'skill:linkedin-posting',
        appId: 'default',
        name: 'linkedin-posting',
        version: 'abc123',
        source: 'admin_uploaded',
        status: 'approved',
        promptRefs: [],
        toolIds: [],
        workflowRefs: [],
        storage: {
          storageType: 'local-filesystem',
          storageRef: 'skill',
          contentHash,
          sizeBytes: 1,
        },
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:00.000Z',
      },
    ]),
  } as unknown as SkillCatalogRepository;
}

function secretRepository(
  values: Record<string, string>,
): CapabilitySecretRepository {
  return {
    getSecret: vi.fn(async (input: { appId: AppId; name: string }) => {
      const value = values[input.name];
      return value
        ? {
            id: `secret:${input.appId}:${input.name}` as never,
            appId: input.appId,
            name: input.name,
            value,
            allowedCapabilityIds: [],
            createdAt: '2026-05-14T00:00:00.000Z',
            updatedAt: '2026-05-14T00:00:00.000Z',
          }
        : null;
    }),
    listSecrets: vi.fn(async () => []),
    upsertSecret: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    deleteSecret: vi.fn(async () => false),
  };
}

describe('job readiness service', () => {
  it('reports ready when declared requirements have durable bindings and browser state', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({ tool_access_requirements: ['Browser'] }),
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

  it('passes skill action requirements through target agent skill grants', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        tool_access_requirements: ['capability:skill.linkedin-posting.publish'],
      }),
      appId: 'default',
      agentId: 'agent:agent-one',
      toolRepository: skillActionToolRepository(),
      skillRepository: selectedLinkedInSkillRepository(),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('blocks skill action requirements when the selected skill hash changed', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        tool_access_requirements: ['capability:skill.linkedin-posting.publish'],
      }),
      appId: 'default',
      agentId: 'agent:agent-one',
      toolRepository: skillActionToolRepository(),
      skillRepository: selectedLinkedInSkillRepository('sha256:changed'),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'missing_capability',
      requirementType: 'semantic_capability',
      requirementId: 'capability:skill.linkedin-posting.publish',
    });
  });

  it('pauses for missing durable tool capabilities', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({ tool_access_requirements: ['Browser'] }),
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
      job: makeJob({ tool_access_requirements: ['Browser'] }),
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
        tool_access_requirements: ['Browser'],
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
      job: makeJob({ tool_access_requirements: ['capability:unknown.tool'] }),
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

  it('does not require the OneCLI broker for provider-neutral configured capabilities', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        tool_access_requirements: ['capability:google.sheets.write'],
      }),
      appId: 'default',
      toolRepository: toolRepository(['capability:google.sheets.write']),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('uses the declared local CLI implementation instead of the builtin provider path', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        tool_access_requirements: ['capability:google.sheets.write'],
        capability_requirements: [
          {
            capabilityId: 'google.sheets.write',
            reason: 'Write lead rows after each run',
            implementation: {
              kind: 'local_cli',
              name: 'gog',
              executablePath: '/usr/local/bin/gog',
              executableVersion: 'v0.9.0',
              executableHash: 'sha256:abc123',
              commandTemplate:
                '/usr/local/bin/gog sheets append <sheet_id> ...',
              networkHosts: ['oauth2.googleapis.com', 'sheets.googleapis.com'],
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['capability:google.sheets.write']),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers).toEqual([
      expect.objectContaining({
        state: 'draft_only',
        requirementType: 'local_cli',
        requirementId: 'google.sheets.write',
        message: expect.stringContaining('using gog'),
      }),
    ]);
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      'propose_capability',
    );
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      '"source":"local_cli"',
    );
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      '"executableHash":"sha256:abc123"',
    );
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      '"networkHosts":["oauth2.googleapis.com","sheets.googleapis.com"]',
    );
    expect(result.setupState.blockers[0]?.message).not.toContain('OneCLI');
  });

  it('treats a declared local CLI implementation as ready when its scoped RunCommand rule is bound', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        tool_access_requirements: ['capability:google.sheets.write'],
        capability_requirements: [
          {
            capabilityId: 'google.sheets.write',
            reason: 'Write lead rows after each run',
            implementation: {
              kind: 'local_cli',
              name: 'gog',
              executablePath: '/usr/local/bin/gog',
              executableVersion: 'v0.9.0',
              executableHash: 'sha256:abc123',
              commandTemplate:
                '/usr/local/bin/gog sheets append <sheet_id> ...',
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository([
        'capability:google.sheets.write',
        'RunCommand(/usr/local/bin/gog sheets append *)',
      ]),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('requires pinned local CLI executable identity before proposing job access', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        tool_access_requirements: ['capability:google.sheets.write'],
        capability_requirements: [
          {
            capabilityId: 'google.sheets.write',
            reason: 'Write lead rows after each run',
            implementation: {
              kind: 'local_cli',
              name: 'gog',
              executablePath: '/usr/local/bin/gog',
              commandTemplate:
                '/usr/local/bin/gog sheets append <sheet_id> ...',
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['capability:google.sheets.write']),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers).toEqual([
      expect.objectContaining({
        state: 'missing_capability',
        requirementType: 'local_cli',
        message: expect.stringContaining('pinned executable version and hash'),
        nextAction: expect.stringContaining('scheduler_update_job'),
      }),
    ]);
    expect(result.setupState.blockers[0]?.nextAction).not.toContain(
      'request_permission',
    );
  });

  it('rejects persisted relative local CLI templates instead of converting legacy setup guidance', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        tool_access_requirements: ['capability:google.sheets.write'],
        capability_requirements: [
          {
            capabilityId: 'google.sheets.write',
            reason: 'Write lead rows after each run',
            implementation: {
              kind: 'local_cli',
              name: 'gog',
              commandTemplate: 'gog sheets append <sheet_id> ...',
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository([
        'capability:google.sheets.write',
        'RunCommand(gog sheets append *)',
      ]),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers).toEqual([
      expect.objectContaining({
        state: 'missing_capability',
        requirementType: 'local_cli',
        message: expect.stringContaining('invalid local CLI job requirement'),
        nextAction: expect.stringContaining('scheduler_update_job'),
      }),
    ]);
    expect(result.setupState.blockers[0]?.nextAction).not.toContain(
      '"rule":"gog sheets append *"',
    );
    expect(result.setupState.blockers[0]?.nextAction).not.toContain(
      'propose_capability',
    );
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

  it('accepts required MCP server credentials from Gantry Secrets', async () => {
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
      capabilitySecretRepository: secretRepository({
        GOOGLE_TOKEN_REF: 'secret-value',
      }),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('turns runtime denied tool use into setup state', () => {
    const setup = setupStateForDeniedTool({
      toolName: 'mcp__gantry__service_restart',
      recoveryAction: 'request_permission ...',
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup).toMatchObject({
      state: 'missing_capability',
      blockers: [
        {
          requirementType: 'tool',
          requirementId: 'mcp__gantry__service_restart',
          nextAction: 'request_permission ...',
        },
      ],
    });
  });

  it('canonicalizes projected browser tool denials to Browser setup', () => {
    const setup = setupStateForDeniedTool({
      toolName: 'mcp__gantry__browser_act',
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup.blockers[0]).toMatchObject({
      requirementType: 'browser',
      requirementId: 'Browser',
      nextAction: expect.stringContaining('"toolName":"Browser"'),
    });
  });

  it('preserves scoped recovery actions for transient permission setup blockers', () => {
    const setup = setupStateForTransientPermission({
      toolName: 'Bash',
      mode: 'allow_once',
      recoveryAction:
        'request_permission {"toolName":"RunCommand","rule":"npm test *"}',
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup.blockers[0]).toMatchObject({
      requirementType: 'tool',
      requirementId: 'RunCommand',
      nextAction:
        'request_permission {"toolName":"RunCommand","rule":"npm test *"}',
    });
  });
});
