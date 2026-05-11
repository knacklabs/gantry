import { describe, expect, it } from 'vitest';

import {
  assertJobExtraToolsAllowedForTarget,
  normalizeJobExtraTools,
  resolveJobToolPolicy,
} from '@core/application/jobs/job-tool-policy.js';

describe('job tool policy', () => {
  it('rejects the agent_browser MCP wildcard as a job-scoped extra', () => {
    expect(() =>
      assertJobExtraToolsAllowedForTarget({
        rules: ['mcp__agent_browser__*'],
        inheritedTools: ['Browser'],
      }),
    ).toThrowError(
      /Request persistent Browser capability first with request_permission temporaryOnly=false/,
    );
  });

  it('rejects concrete agent_browser MCP tools as job-scoped extras', () => {
    for (const rule of [
      'mcp__agent_browser__navigate',
      'mcp__playwright__browser_click',
      'mcp__puppeteer__screenshot',
    ]) {
      expect(() =>
        assertJobExtraToolsAllowedForTarget({
          rules: [rule],
          inheritedTools: ['Browser'],
        }),
      ).toThrowError(
        /browser action MCP tool and cannot be added as a job-scoped extra/,
      );
    }
  });

  it('rejects projected browser tools as job-scoped extras', () => {
    expect(() =>
      assertJobExtraToolsAllowedForTarget({
        rules: ['mcp__myclaw__browser_click'],
        inheritedTools: ['Browser'],
      }),
    ).toThrowError(
      /runtime projection and cannot be added as a job-scoped extra/,
    );
  });

  it('rejects stale inherited agent_browser MCP rules from agent tool bindings', () => {
    expect(() =>
      assertJobExtraToolsAllowedForTarget({
        rules: ['Read'],
        inheritedTools: ['mcp__agent_browser__*'],
      }),
    ).toThrowError(/canonical Browser tool capability/);
  });

  it('rejects stale inherited projected browser MCP rules from agent tool bindings', () => {
    expect(() =>
      assertJobExtraToolsAllowedForTarget({
        rules: ['Read'],
        inheritedTools: ['mcp__myclaw__browser_click'],
      }),
    ).toThrowError(/runtime projections, not durable capabilities/);
  });

  it('keeps non-browser MCP server wildcard validation available for job extras', () => {
    expect(normalizeJobExtraTools(['mcp__github__*'])).toEqual([
      'mcp__github__*',
    ]);
  });

  it('allows Browser inheritance without browser action MCP job extras', async () => {
    await expect(
      resolveJobToolPolicy({
        job: {
          id: 'job-browser-intent',
          type: 'one_time',
          group_scope: 'team',
          prompt: 'navigate to https://example.com in the browser',
          created_at: '2026-05-09T00:00:00.000Z',
          updated_at: '2026-05-09T00:00:00.000Z',
          created_by: 'user',
          capability_policy: { allowed_tools: [] },
        } as never,
        appId: 'default',
        agentId: 'agent:team',
        toolRepository: {
          listAgentToolBindings: async () => [
            { toolId: 'tool:Browser', status: 'active' },
          ],
          getTool: async () => ({
            id: 'tool:Browser',
            appId: 'default',
            name: 'Browser',
          }),
        } as never,
      }),
    ).resolves.toMatchObject({
      inheritedTools: ['Browser'],
      jobExtraTools: [],
      effectiveAllowedTools: ['Browser'],
    });
  });
});
