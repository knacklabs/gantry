import { describe, expect, it } from 'vitest';

import { resolveJobToolPolicy } from '@core/application/jobs/job-tool-policy.js';
import type { Job } from '@core/domain/types.js';
import { resolveConfiguredAllowedTools } from '@core/runtime/configured-agent-tools.js';
import {
  buildLocalCliSemanticCapability,
  semanticCapabilityInputSchema,
} from '@core/shared/semantic-capabilities.js';

const reviewedAcmeAppendCapability = buildLocalCliSemanticCapability({
  capabilityId: 'acme.records.append',
  displayName: 'Acme records append',
  category: 'Acme Records',
  risk: 'write',
  can: 'Append records through reviewed Acme access.',
  cannot: 'Delete records, export secrets, or change account settings.',
  executablePath: '/usr/local/bin/acme',
  executableVersion: 'v1.0.0',
  executableHash: 'sha256:abc123',
  commandTemplates: ['/usr/local/bin/acme records append *'],
});

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-browser-intent',
    name: 'Browser job',
    prompt: 'navigate to https://example.com in the browser',
    schedule_type: 'once',
    schedule_value: '2026-05-09T00:00:00.000Z',
    status: 'active',
    session_id: null,
    thread_id: null,
    workspace_key: 'team',
    created_by: 'agent',
    created_at: '2026-05-09T00:00:00.000Z',
    updated_at: '2026-05-09T00:00:00.000Z',
    next_run: null,
    last_run: null,
    silent: false,
    cleanup_after_ms: 86_400_000,
    timeout_ms: 300_000,
    max_retries: 1,
    retry_backoff_ms: 1,
    max_consecutive_failures: 3,
    consecutive_failures: 0,
    lease_run_id: null,
    lease_expires_at: null,
    pause_reason: null,
    ...overrides,
  };
}

function toolRepositoryFor(names: string[]) {
  const toolFor = (toolId: string) => {
    const name = toolId.replace(/^tool:/, '');
    return {
      id: toolId,
      appId: 'default',
      name,
      inputSchema:
        name === 'capability:acme.records.append'
          ? semanticCapabilityInputSchema(reviewedAcmeAppendCapability)
          : undefined,
    };
  };
  return {
    listTools: async () => names.map((name) => toolFor(`tool:${name}`)),
    listAgentToolBindings: async () =>
      names.map((name) => ({ toolId: `tool:${name}`, status: 'active' })),
    getTool: async (toolId: string) => toolFor(toolId),
  } as never;
}

describe('job tool policy', () => {
  it('resolves scheduled job tools from the target agent only', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['Browser']),
      }),
    ).resolves.toEqual({
      inheritedTools: ['Browser'],
      effectiveAllowedTools: ['Browser'],
      runtimeAccess: [],
    });
  });

  it('rejects stale inherited host-private browser MCP rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor([
          'mcp__browser' + '_' + 'backend' + '__*',
        ]),
      }),
    ).rejects.toThrowError(/canonical Browser tool capability/);
  });

  it('rejects stale inherited projected browser MCP rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__gantry__browser_act']),
      }),
    ).rejects.toThrowError(/runtime projections, not durable capabilities/);
  });

  it('rejects stale inherited Gantry MCP wildcard rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__gantry__*']),
      }),
    ).rejects.toThrowError(/wildcard grants are not supported/);
  });

  it('drops stale inherited over-broad RunCommand rules instead of failing the whole policy', async () => {
    // A stale/over-broad RunCommand grant (e.g. RunCommand(*)) is now dropped
    // from the projection rather than throwing: throwing would take down every
    // other durable grant for the agent (the caller swallows it to undefined).
    // Dropped means it grants nothing — the command re-asks (fail-closed).
    const policy = await resolveJobToolPolicy({
      job: makeJob(),
      appId: 'default',
      agentId: 'agent:team',
      toolRepository: toolRepositoryFor(['RunCommand(*)']),
    });
    expect(policy.effectiveAllowedTools).not.toContain('RunCommand(*)');
    expect(policy.effectiveAllowedTools).toEqual([]);
  });

  it('rejects stale inherited third-party MCP wildcard rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__github__*']),
      }),
    ).rejects.toThrowError(/request a reviewed semantic capability/);
  });

  it('rejects stale inherited exact third-party MCP tool rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__github__search_repositories']),
      }),
    ).rejects.toThrowError(
      /Third-party MCP tools must be projected from a reviewed semantic capability/,
    );
  });

  it('matches the interactive runtime resolver for the same agent bindings', async () => {
    const repository = toolRepositoryFor([
      'capability:acme.records.append',
      'Browser',
      'RunCommand(npm test *)',
    ]);

    const jobPolicy = await resolveJobToolPolicy({
      job: makeJob(),
      appId: 'default',
      agentId: 'agent:team',
      toolRepository: repository,
    });
    const configuredTools = await resolveConfiguredAllowedTools({
      repository,
      appId: 'default',
      agentId: 'agent:team',
    });

    expect(jobPolicy.effectiveAllowedTools).toEqual(configuredTools);
    // The local_cli capability no longer projects a RunCommand rule (CLIRUN-1
    // cutover); it is invoked via capability_run, so only the capability itself
    // appears here.
    expect(jobPolicy.effectiveAllowedTools).toEqual([
      'capability:acme.records.append',
      'Browser',
      'RunCommand(npm test *)',
    ]);
  });
});
