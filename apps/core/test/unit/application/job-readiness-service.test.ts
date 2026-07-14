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
      requirementType: 'semantic_capability',
      requirementId: 'capability:skill.linkedin-posting.publish',
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
      requirementType: 'browser',
      requirementId: 'Browser',
      message: 'Setup required: capability dependency missing: Browser access.',
    });
    expect(result.setupState.blockers[0]?.message).not.toContain('sandbox');
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
      requirementType: 'semantic_capability',
      requirementId: 'acme.records.append',
      message:
        'This job references a capability that is not reviewed in the capability catalog.',
    });
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      'request_access',
    );
    expect(result.setupState.blockers[0]?.nextAction).not.toContain(
      'request_permission',
    );
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
      requirementType: 'semantic_capability',
      requirementId: 'unknown.tool',
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
        requirementType: 'local_cli',
        requirementId: 'acme.records.append',
        message: expect.stringContaining('using acme'),
      }),
    ]);
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      'request_access',
    );
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      '"kind":"capability"',
    );
    expect(result.setupState.blockers[0]?.nextAction).toContain(
      '"id":"acme.records.append"',
    );
    expect(result.setupState.blockers[0]?.message).not.toContain(
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
        requirementType: 'local_cli',
        message: expect.stringContaining('pinned executable version and hash'),
        nextAction: expect.stringContaining('scheduler_update_job'),
      }),
    ]);
    expect(result.setupState.blockers[0]?.nextAction).not.toContain(
      'request_access',
    );
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
        requirementType: 'local_cli',
        message: expect.stringContaining('invalid local CLI job requirement'),
        nextAction: expect.stringContaining('scheduler_update_job'),
      }),
    ]);
    expect(result.setupState.blockers[0]?.nextAction).not.toContain(
      '"rule":"acme records append *"',
    );
    expect(result.setupState.blockers[0]?.nextAction).not.toContain(
      'request_access',
    );
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
      requirementType: 'mcp_server',
      requirementId: 'records',
    });
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
        requirementType: 'semantic_capability',
        requirementId: 'acme.records.append',
        message: expect.stringContaining('not available in the worker image'),
        nextAction: expect.stringContaining('Rebuild or deploy a worker image'),
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
        requirementType: 'semantic_capability',
        requirementId: 'acme.records.append',
        nextAction: expect.stringContaining('Rebuild or deploy a worker image'),
      }),
    ]);
  });

  it('turns runtime denied tool use into setup state', () => {
    const setup = setupStateForDeniedTool({
      toolName: 'mcp__gantry__service_restart',
      recoveryAction: 'request_access ...',
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup).toMatchObject({
      state: 'missing_capability',
      blockers: [
        {
          requirementType: 'tool',
          requirementId: 'mcp__gantry__service_restart',
          nextAction: 'request_access ...',
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
      nextAction: expect.stringContaining('"id":"browser.use"'),
    });
  });

  it('preserves scoped recovery actions for transient permission setup blockers', () => {
    const setup = setupStateForTransientPermission({
      toolName: 'Bash',
      mode: 'allow_once',
      recoveryAction:
        'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
      checkedAt: '2026-05-14T00:00:00.000Z',
    });

    expect(setup.blockers[0]).toMatchObject({
      requirementType: 'tool',
      requirementId: 'RunCommand',
      nextAction:
        'request_access {"target":{"kind":"run_command","argvPattern":"npm test *"},"temporaryOnly":false,"reason":"This autonomous run requires RunCommand(npm test *) access."}',
    });
  });
});
