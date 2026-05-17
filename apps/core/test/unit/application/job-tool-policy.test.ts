import { describe, expect, it } from 'vitest';

import { resolveJobToolPolicy } from '@core/application/jobs/job-tool-policy.js';
import type { Job } from '@core/domain/types.js';
import { resolveConfiguredAllowedTools } from '@core/runtime/configured-agent-tools.js';

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
    group_scope: 'team',
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
  return {
    listAgentToolBindings: async () =>
      names.map((name) => ({ toolId: `tool:${name}`, status: 'active' })),
    getTool: async (toolId: string) => ({
      id: toolId,
      appId: 'default',
      name: toolId.replace(/^tool:/, ''),
    }),
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
        toolRepository: toolRepositoryFor(['mcp__myclaw__browser_act']),
      }),
    ).rejects.toThrowError(/runtime projections, not durable capabilities/);
  });

  it('rejects stale inherited MyClaw MCP wildcard rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__myclaw__*']),
      }),
    ).rejects.toThrowError(/wildcard grants are not supported/);
  });

  it('rejects stale inherited Bash wildcard rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['Bash(*)']),
      }),
    ).rejects.toThrowError(/Persistent Bash scope is too broad/);
  });

  it('rejects stale inherited third-party MCP wildcard rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__github__*']),
      }),
    ).rejects.toThrowError(/request the MCP server capability/);
  });

  it('rejects stale inherited exact third-party MCP tool rules from agent tool bindings', async () => {
    await expect(
      resolveJobToolPolicy({
        job: makeJob(),
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: toolRepositoryFor(['mcp__github__search_repositories']),
      }),
    ).rejects.toThrowError(/request and bind the MCP server capability/);
  });

  it('matches the interactive runtime resolver for the same agent bindings', async () => {
    const repository = toolRepositoryFor([
      'capability:google.sheets.write',
      'Browser',
      'Bash(npm test *)',
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
    expect(jobPolicy.effectiveAllowedTools).toEqual([
      'capability:google.sheets.write',
      'Browser',
      'Bash(npm test *)',
    ]);
  });
});
