import { describe, expect, it, vi } from 'vitest';
import {
  setupStateForTransientPermission,
  setupStateForBrowserPrelaunchFailure,
} from '@core/application/jobs/job-setup-pause-states.js';

import {
  evaluateJobReadiness,
  setupStateForDeniedTool,
} from '@core/application/jobs/job-readiness-service.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '@core/domain/ports/repositories.js';
import type { AppId } from '@core/domain/app/app.js';
import type { Job } from '@core/domain/types.js';
import type { AgentAccessSnapshot } from '@core/application/agent-execution/agent-access-snapshot.js';
import {
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
} from '@core/shared/semantic-capabilities.js';

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
    workspace_key: 'agent-one',
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
      workspaceKey: 'agent-one',
    },
    ...overrides,
  };
}

const sheetsAppendDefinition: SemanticCapabilityDefinition = {
  capabilityId: 'acme.records.append',
  displayName: 'Acme records append',
  category: 'Acme Records',
  risk: 'write',
  can: 'Append values through a reviewed implementation.',
  cannot: 'Expose raw credentials or manage unrelated Google resources.',
  credentialSource: 'configured_access',
  implementationBindings: [
    { kind: 'tool_rule', rule: 'example.records.append' },
  ],
  preflight: { kind: 'none' },
};

function toolRepository(
  rules: string[],
  definitions: Record<string, SemanticCapabilityDefinition> = {},
): ToolCatalogRepository {
  return {
    listTools: vi.fn(async () =>
      rules.map((rule, index) => {
        const capabilityId = rule.startsWith('capability:')
          ? rule.slice('capability:'.length)
          : undefined;
        const definition = capabilityId ? definitions[capabilityId] : undefined;
        return {
          appId: 'default',
          id: `tool:${index}`,
          name: rule,
          selectable: true,
          status: 'active',
          ...(definition
            ? { inputSchema: semanticCapabilityInputSchema(definition) }
            : {}),
        };
      }),
    ),
    listAgentToolBindings: vi.fn(async () =>
      rules.map((rule, index) => ({
        status: 'active',
        toolId: `tool:${index}`,
      })),
    ),
    getTool: vi.fn(async (toolId: string) => {
      const index = Number(toolId.replace('tool:', ''));
      const rule = rules[index];
      const capabilityId = rule?.startsWith('capability:')
        ? rule.slice('capability:'.length)
        : undefined;
      const definition = capabilityId ? definitions[capabilityId] : undefined;
      return {
        appId: 'default',
        name: rule,
        ...(definition
          ? { inputSchema: semanticCapabilityInputSchema(definition) }
          : {}),
      };
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
            actionId: 'publish',
          },
        },
      },
    })),
  } as unknown as ToolCatalogRepository;
}

function selectedLinkedInSkillRepository(
  actions: Array<Record<string, unknown>> = [
    {
      id: 'publish',
      capabilityId: 'skill.linkedin-posting.publish',
      displayName: 'LinkedIn posting',
      risk: 'write',
      can: 'Publish a prepared LinkedIn post.',
      cannot: 'Read unrelated credentials.',
      requiredEnvVars: [],
      commandTemplates: ['skills/linkedin-posting/post.py *'],
    },
  ],
): SkillCatalogRepository {
  return {
    listEnabledSkillsForAgent: vi.fn(async () => [
      {
        id: 'skill:linkedin-posting',
        appId: 'default',
        name: 'linkedin-posting',
        version: 'abc123',
        source: 'admin_uploaded',
        status: 'installed',
        promptRefs: [],
        toolIds: [],
        workflowRefs: [],
        actionPermissions: actions,
        storage: {
          storageType: 'local-filesystem',
          storageRef: 'skill',
          contentHash: 'sha256:abc123',
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
  it('uses one access snapshot for tool policy and semantic catalog readiness', async () => {
    const definition = {
      appId: 'default',
      id: 'tool:records',
      name: 'capability:acme.records.append',
      selectable: true,
      status: 'active',
      inputSchema: semanticCapabilityInputSchema(sheetsAppendDefinition),
    };
    const repository = toolRepository([]);
    const accessSnapshot = {
      appId: 'default',
      agentId: 'agent:agent-one',
      tools: {
        activeBindings: [
          {
            binding: {
              appId: 'default',
              agentId: 'agent:agent-one',
              toolId: 'tool:records',
              status: 'active',
            },
            definition,
          },
        ],
        appActiveDefinitions: [definition],
      },
      skills: { activeBindings: [], enabledDefinitions: [] },
      mcp: { activeBindings: [], materializedServers: [] },
    } as unknown as AgentAccessSnapshot;

    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'tool_rule',
              rule: 'capability:acme.records.append',
            },
          },
        ],
      }),
      appId: 'default',
      agentId: 'agent:agent-one',
      toolRepository: repository,
      accessSnapshot,
      workerImageInventory: ['acme.records.append'],
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(repository.listAgentToolBindings).not.toHaveBeenCalled();
    expect(repository.listTools).not.toHaveBeenCalled();
    expect(repository.getTool).not.toHaveBeenCalled();
  });

  it('uses snapshot MCP access while checking credentials live', async () => {
    const record = {
      definition: {
        id: 'mcp:server-1',
        appId: 'default',
        name: 'records',
        status: 'active',
        credentialRefs: [
          { name: 'GOOGLE_TOKEN_REF', target: 'env', key: 'TOKEN' },
        ],
      },
      binding: {
        appId: 'default',
        agentId: 'agent:agent-one',
        serverId: 'mcp:server-1',
        status: 'active',
      },
    };
    const listMaterializedServersForAgent = vi.fn(async () => []);
    const repository = {
      listMaterializedServersForAgent,
    } as unknown as McpServerRepository;
    const secrets = secretRepository({
      GOOGLE_TOKEN_REF: 'secret-value',
    });
    const accessSnapshot = {
      appId: 'default',
      agentId: 'agent:agent-one',
      tools: { activeBindings: [], appActiveDefinitions: [] },
      skills: { activeBindings: [], enabledDefinitions: [] },
      mcp: {
        activeBindings: [record],
        materializedServers: [record],
      },
    } as unknown as AgentAccessSnapshot;

    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          { target: { kind: 'mcp_server', server: 'records' } },
        ],
      }),
      appId: 'default',
      agentId: 'agent:agent-one',
      mcpServerRepository: repository,
      capabilitySecretRepository: secrets,
      accessSnapshot,
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(listMaterializedServersForAgent).not.toHaveBeenCalled();
    expect(secrets.getSecret).toHaveBeenCalled();
  });

  it('keeps the live disabled-server diagnostic for snapshot MCP misses', async () => {
    const listMaterializedServersForAgent = vi.fn(async () => []);
    const getServerByName = vi.fn(async () => ({
      id: 'mcp:server-1',
      appId: 'default',
      name: 'records',
      status: 'disabled',
    }));
    const repository = {
      listMaterializedServersForAgent,
      getServerByName,
    } as unknown as McpServerRepository;

    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          { target: { kind: 'mcp_server', server: 'records' } },
        ],
      }),
      appId: 'default',
      agentId: 'agent:agent-one',
      mcpServerRepository: repository,
      accessSnapshot: {
        appId: 'default',
        agentId: 'agent:agent-one',
        tools: { activeBindings: [], appActiveDefinitions: [] },
        skills: { activeBindings: [], enabledDefinitions: [] },
        mcp: { activeBindings: [], materializedServers: [] },
      },
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.setupState.blockers[0]?.summary).toBe(
      'Required MCP server is disabled: records.',
    );
    expect(listMaterializedServersForAgent).not.toHaveBeenCalled();
    expect(getServerByName).toHaveBeenCalledOnce();
  });

  it('rejects an access snapshot owned by another agent', async () => {
    await expect(
      evaluateJobReadiness({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:agent-one',
        accessSnapshot: {
          appId: 'default',
          agentId: 'agent:other',
          tools: { activeBindings: [], appActiveDefinitions: [] },
          skills: { activeBindings: [], enabledDefinitions: [] },
          mcp: { activeBindings: [], materializedServers: [] },
        },
      }),
    ).rejects.toThrow('Job readiness access snapshot owner mismatch.');
  });

  it('reports ready when declared requirements have durable bindings and browser state', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
      }),
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
        access_requirements: [
          {
            target: {
              kind: 'tool_rule',
              rule: 'capability:skill.linkedin-posting.publish',
            },
          },
        ],
      }),
      appId: 'default',
      agentId: 'agent:agent-one',
      toolRepository: skillActionToolRepository(),
      skillRepository: selectedLinkedInSkillRepository(),
      workerImageInventory: ['skill.linkedin-posting.publish'],
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('blocks skill action requirements when the selected skill no longer declares the action', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'tool_rule',
              rule: 'capability:skill.linkedin-posting.publish',
            },
          },
        ],
      }),
      appId: 'default',
      agentId: 'agent:agent-one',
      toolRepository: skillActionToolRepository(),
      skillRepository: selectedLinkedInSkillRepository([]),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'missing_capability',
      type: 'semantic_capability',
      id: 'capability:skill.linkedin-posting.publish',
    });
  });

  it('pauses for missing durable tool capabilities', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository([]),
      workerImageInventory: ['acme.records.append'],
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.pauseReason).toBe('Setup required');
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'missing_capability',
      type: 'browser',
      id: 'Browser',
      summary: 'Setup required: capability dependency missing: Browser access.',
    });
    expect(result.setupState.blockers[0]?.summary).not.toContain('sandbox');
  });

  it('does not turn unreviewed semantic job requirements into grant prompts', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'tool_rule',
              rule: 'capability:acme.records.append',
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository([]),
      workerImageInventory: ['acme.records.append'],
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'missing_capability',
      type: 'semantic_capability',
      id: 'acme.records.append',
      summary:
        'This job references a capability that is not reviewed in the capability catalog.',
    });
    expect(result.setupState.blockers[0]?.action).toMatchObject({
      kind: 'instruction',
      text: expect.stringContaining('request_access'),
    });
  });

  it('does not block jobs on Browser login marker absence after durable Browser approval', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['Browser']),
      getBrowserStatus: vi.fn(async () => ({ hasState: false })),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState).toMatchObject({
      state: 'ready',
      blockers: [],
    });
  });

  it('does not require a Browser profile preflight for an approved Browser job', async () => {
    const getBrowserStatus = vi.fn(async () => ({ hasState: false }));

    const result = await evaluateJobReadiness({
      job: makeJob({
        workspace_key: 'main_agent',
        access_requirements: [
          { target: { kind: 'tool_rule', rule: 'Browser' } },
        ],
        execution_context: {
          conversationJid: 'tg:-1003986348737',
          threadId: null,
          workspaceKey: 'main_agent',
        },
      }),
      agentId: 'agent:main_agent',
      appId: 'default',
      toolRepository: toolRepository(['Browser']),
      getBrowserStatus,
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(getBrowserStatus).not.toHaveBeenCalled();
    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('blocks unknown semantic capabilities even when a stale tool rule exists', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          { target: { kind: 'tool_rule', rule: 'capability:unknown.tool' } },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['capability:unknown.tool']),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'missing_capability',
      type: 'semantic_capability',
      id: 'unknown.tool',
    });
  });

  it('does not require the Gantry Model Gateway broker for provider-neutral configured capabilities', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'tool_rule',
              rule: 'capability:acme.records.append',
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['capability:acme.records.append'], {
        'acme.records.append': sheetsAppendDefinition,
      }),
      workerImageInventory: ['acme.records.append'],
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('uses the declared local CLI implementation instead of the builtin provider path', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
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
                commandTemplate:
                  '/usr/local/bin/acme records append <sheet_id> ...',
                networkHosts: [
                  'oauth2.googleapis.com',
                  'records.googleapis.com',
                ],
              },
            },
            reason: 'Write lead rows after each run',
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository([]),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers).toEqual([
      expect.objectContaining({
        state: 'missing_capability',
        type: 'local_cli',
        id: 'acme.records.append',
        summary: expect.stringContaining('using acme'),
      }),
    ]);
    expect(result.setupState.blockers[0]?.action).toMatchObject({
      kind: 'approve_grant',
      grant: { rules: [{ toolName: 'RunCommand' }] },
    });
    expect(result.setupState.blockers[0]?.summary).not.toContain(
      'Gantry Model Gateway',
    );
  });

  it('treats a declared local CLI implementation as ready when its scoped RunCommand rule is bound', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
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
                commandTemplate:
                  '/usr/local/bin/acme records append <sheet_id> ...',
              },
            },
            reason: 'Write lead rows after each run',
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository([
        'RunCommand(/usr/local/bin/acme records append *)',
      ]),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('requires pinned local CLI executable identity before proposing job access', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'capability',
              capabilityId: 'acme.records.append',
              implementation: {
                kind: 'local_cli',
                name: 'acme',
                executablePath: '/usr/local/bin/acme',
                commandTemplate:
                  '/usr/local/bin/acme records append <sheet_id> ...',
              },
            },
            reason: 'Write lead rows after each run',
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository([]),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers).toEqual([
      expect.objectContaining({
        state: 'missing_capability',
        type: 'local_cli',
        summary: expect.stringContaining('pinned executable version and hash'),
        action: expect.objectContaining({
          kind: 'instruction',
          text: expect.stringContaining('scheduler_update_job'),
        }),
      }),
    ]);
  });

  it('rejects persisted relative local CLI templates instead of converting legacy setup guidance', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'capability',
              capabilityId: 'acme.records.append',
              implementation: {
                kind: 'local_cli',
                name: 'acme',
                commandTemplate: 'acme records append <sheet_id> ...',
              },
            },
            reason: 'Write lead rows after each run',
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['RunCommand(acme records append *)']),
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers).toEqual([
      expect.objectContaining({
        state: 'missing_capability',
        type: 'local_cli',
        summary: expect.stringContaining('invalid local CLI job requirement'),
        action: expect.objectContaining({
          kind: 'instruction',
          text: expect.stringContaining('scheduler_update_job'),
        }),
      }),
    ]);
  });

  it('reports MCP credential blockers without starting the MCP server', async () => {
    const repository = {
      listMaterializedServersForAgent: vi.fn(async () => [
        {
          definition: {
            id: 'mcp:server-1',
            appId: 'default',
            name: 'records',
            status: 'active',
            credentialRefs: [
              { name: 'GOOGLE_TOKEN_REF', target: 'env', key: 'TOKEN' },
            ],
          },
          binding: { status: 'active' },
        },
      ]),
    } as unknown as McpServerRepository;

    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          { target: { kind: 'mcp_server', server: 'records' } },
        ],
      }),
      appId: 'default',
      mcpServerRepository: repository,
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(repository.listMaterializedServersForAgent).toHaveBeenCalled();
    expect(result.setupState.blockers[0]).toMatchObject({
      state: 'mcp_missing_credential',
      type: 'mcp_server',
      id: 'records',
      summary:
        'A Gantry credential is required before this can run. Add it in Credential Center, then try again.',
      action: {
        kind: 'instruction',
        text: 'Add the required credentials in Credential Center, then resume or recheck the job.',
      },
    });
    expect(JSON.stringify(result.setupState.blockers[0])).not.toContain(
      'GOOGLE_TOKEN_REF',
    );
    expect(JSON.stringify(result.setupState.blockers[0])).not.toContain(
      'gantry credentials access set',
    );
  });

  it('accepts required MCP server credentials from Gantry Credentials', async () => {
    const repository = {
      listMaterializedServersForAgent: vi.fn(async () => [
        {
          definition: {
            id: 'mcp:server-1',
            appId: 'default',
            name: 'records',
            status: 'active',
            credentialRefs: [
              { name: 'GOOGLE_TOKEN_REF', target: 'env', key: 'TOKEN' },
            ],
          },
          binding: { status: 'active' },
        },
      ]),
    } as unknown as McpServerRepository;

    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          { target: { kind: 'mcp_server', server: 'records' } },
        ],
      }),
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

  it('admits a job when its selected capability is in the worker image inventory', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'tool_rule',
              rule: 'capability:acme.records.append',
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['capability:acme.records.append'], {
        'acme.records.append': sheetsAppendDefinition,
      }),
      workerImageInventory: ['acme.records.append'],
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(true);
    expect(result.setupState.blockers).toEqual([]);
  });

  it('fails closed when a selected capability is missing from the worker image inventory', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'tool_rule',
              rule: 'capability:acme.records.append',
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['capability:acme.records.append'], {
        'acme.records.append': sheetsAppendDefinition,
      }),
      workerImageInventory: ['some.other.capability'],
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.pauseReason).toBe('Setup required');
    expect(result.setupState.blockers).toEqual([
      expect.objectContaining({
        state: 'missing_capability',
        type: 'semantic_capability',
        id: 'acme.records.append',
        summary: expect.stringContaining('not available in the worker image'),
        action: expect.objectContaining({
          kind: 'instruction',
          text: expect.stringContaining('Rebuild or deploy a worker image'),
        }),
      }),
    ]);
  });

  it('fails closed when the worker image inventory is empty', async () => {
    const result = await evaluateJobReadiness({
      job: makeJob({
        access_requirements: [
          {
            target: {
              kind: 'tool_rule',
              rule: 'capability:acme.records.append',
            },
          },
        ],
      }),
      appId: 'default',
      toolRepository: toolRepository(['capability:acme.records.append'], {
        'acme.records.append': sheetsAppendDefinition,
      }),
      workerImageInventory: [],
      clock: { now: () => '2026-05-14T00:00:00.000Z' },
    });

    expect(result.ready).toBe(false);
    expect(result.setupState.blockers).toEqual([
      expect.objectContaining({
        state: 'missing_capability',
        type: 'semantic_capability',
        id: 'acme.records.append',
        action: expect.objectContaining({
          kind: 'instruction',
          text: expect.stringContaining('Rebuild or deploy a worker image'),
        }),
      }),
    ]);
  });

  it('turns runtime denied tool use into setup state', () => {
    const setup = setupStateForDeniedTool({
      toolName: 'mcp__gantry__service_restart',
      action: { kind: 'instruction', text: 'Review setup.' },
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup).toMatchObject({
      state: 'missing_capability',
      blockers: [
        {
          type: 'tool',
          id: 'mcp__gantry__service_restart',
          action: { kind: 'instruction', text: 'Review setup.' },
        },
      ],
    });
  });

  it('canonicalizes projected browser tool denials to Browser setup', () => {
    const setup = setupStateForDeniedTool({
      toolName: 'mcp__gantry__browser_act',
      action: {
        kind: 'approve_grant',
        grant: {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:browser.use' }],
        },
      },
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup.blockers[0]).toMatchObject({
      type: 'browser',
      id: 'Browser',
      action: expect.objectContaining({ kind: 'approve_grant' }),
    });
  });

  it('pauses a bare command transient with plain-language instruction (never protocol text)', () => {
    const setup = setupStateForTransientPermission({
      toolName: 'Bash',
      mode: 'allow_once',
      recoveryAction:
        'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup.blockers[0]).toMatchObject({
      type: 'tool',
      id: 'RunCommand',
      action: {
        kind: 'instruction',
        text: 'This job used temporary command access. Approve a scoped command grant from its approval card, then resume the job.',
      },
    });
  });
});
