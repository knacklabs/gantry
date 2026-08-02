import { describe, expect, it } from 'vitest';

import { buildReviewedMcpCapabilityCandidate } from '@core/application/mcp/mcp-capability-candidate.js';
import type { McpServerRepository } from '@core/domain/ports/repositories.js';

function repositoryFor(input: {
  appId: string;
  allowedToolPatterns?: string[];
  autoApproveToolPatterns?: string[];
  url?: string;
  conversationId?: string;
  threadId?: string;
}): McpServerRepository {
  const server = {
    id: `mcp:${input.appId}:sum`,
    appId: input.appId,
    name: 'sum',
    status: 'active',
    createdSource: 'admin',
    riskClass: 'low',
    transport: 'http',
    config: {
      transport: 'http',
      url: input.url ?? 'http://127.0.0.1:3000/mcp',
    },
    allowedToolPatterns: input.allowedToolPatterns ?? [],
    autoApproveToolPatterns: input.autoApproveToolPatterns ?? [],
    credentialRefs: [],
    networkHosts: [],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  };
  const binding = {
    id: `agent-mcp-binding:agent:test:${server.id}`,
    appId: input.appId,
    agentId: 'agent:test',
    serverId: server.id,
    status: 'active',
    required: false,
    permissionPolicyIds: [],
    allowedToolPatterns: [],
    conversationId: input.conversationId,
    threadId: input.threadId,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
  return {
    getServerByName: async ({ appId, name }) =>
      appId === input.appId && name === server.name ? (server as never) : null,
    listAgentBindings: async () => [binding as never],
  } as McpServerRepository;
}

describe('reviewed MCP capability candidates', () => {
  it('uses the canonical auto-approve fallback as reviewed source scope', async () => {
    const candidate = await buildReviewedMcpCapabilityCandidate({
      mcpServers: repositoryFor({
        appId: 'app:auto',
        autoApproveToolPatterns: ['get-sum'],
      }),
      appId: 'app:auto' as never,
      agentId: 'agent:test' as never,
      serverName: 'sum',
      tools: ['get-sum'],
      risk: 'read',
      displayName: 'Read sums',
    });

    expect(candidate.patterns).toEqual(['get-sum']);
    expect(candidate.definition.implementationBindings).toEqual([
      {
        kind: 'mcp_pattern',
        mcpServer: 'sum',
        mcpToolPatterns: ['get-sum'],
      },
    ]);
    expect(candidate.definition.source).toMatchObject({
      kind: 'mcp_capability_proposal',
      serverId: 'mcp:app:auto:sum',
      serverDefinitionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('derives distinct catalog identities for the same scope in different apps', async () => {
    const buildForApp = (appId: string) =>
      buildReviewedMcpCapabilityCandidate({
        mcpServers: repositoryFor({
          appId,
          allowedToolPatterns: ['get-sum'],
        }),
        appId: appId as never,
        agentId: 'agent:test' as never,
        serverName: 'sum',
        tools: ['get-sum'],
        risk: 'read',
        displayName: 'Read sums',
      });

    const [first, second] = await Promise.all([
      buildForApp('app:one'),
      buildForApp('app:two'),
    ]);

    expect(first.definition.capabilityId).not.toBe(
      second.definition.capabilityId,
    );
  });

  it('rejects a proposal outside the connected binding conversation and thread', async () => {
    const mcpServers = repositoryFor({
      appId: 'app:routed',
      allowedToolPatterns: ['get-sum'],
      conversationId: 'conversation:approved',
      threadId: 'thread:approved',
    });
    const build = (conversationId: string, threadId: string) =>
      buildReviewedMcpCapabilityCandidate({
        mcpServers,
        appId: 'app:routed' as never,
        agentId: 'agent:test' as never,
        conversationId,
        threadId,
        serverName: 'sum',
        tools: ['get-sum'],
        risk: 'read',
        displayName: 'Read sums',
      });

    await expect(
      build('conversation:other', 'thread:approved'),
    ).rejects.toThrow('is not active for this agent');
    await expect(
      build('conversation:approved', 'thread:other'),
    ).rejects.toThrow('is not active for this agent');
    await expect(
      build('conversation:approved', 'thread:approved'),
    ).resolves.toMatchObject({ patterns: ['get-sum'] });
  });

  it('derives a fresh catalog identity after the source authority changes', async () => {
    const buildForUrl = (url: string) =>
      buildReviewedMcpCapabilityCandidate({
        mcpServers: repositoryFor({
          appId: 'app:revisioned',
          allowedToolPatterns: ['get-sum'],
          url,
        }),
        appId: 'app:revisioned' as never,
        agentId: 'agent:test' as never,
        serverName: 'sum',
        tools: ['get-sum'],
        risk: 'read',
        displayName: 'Read sums',
      });

    const [first, second] = await Promise.all([
      buildForUrl('http://127.0.0.1:3000/mcp'),
      buildForUrl('http://127.0.0.1:4000/mcp'),
    ]);

    expect(first.definition.capabilityId).not.toBe(
      second.definition.capabilityId,
    );
  });

  it('rejects a scope that cannot be displayed completely before approval', async () => {
    const tools = Array.from(
      { length: 50 },
      (_, index) =>
        `sensitive_${String(index).padStart(2, '0')}_${'x'.repeat(80)}`,
    );

    await expect(
      buildReviewedMcpCapabilityCandidate({
        mcpServers: repositoryFor({
          appId: 'app:large',
          allowedToolPatterns: ['sensitive_*'],
        }),
        appId: 'app:large' as never,
        agentId: 'agent:test' as never,
        serverName: 'sum',
        tools,
        risk: 'read',
        displayName: 'Oversized scope',
      }),
    ).rejects.toThrow('too large to display completely');
  });

  it('rejects a scope the permission sanitizer would hide before approval', async () => {
    const opaqueTool = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.-AbCd';

    await expect(
      buildReviewedMcpCapabilityCandidate({
        mcpServers: repositoryFor({
          appId: 'app:opaque',
          allowedToolPatterns: [opaqueTool],
        }),
        appId: 'app:opaque' as never,
        agentId: 'agent:test' as never,
        serverName: 'sum',
        tools: [opaqueTool],
        risk: 'read',
        displayName: 'Opaque scope',
      }),
    ).rejects.toThrow('cannot be displayed safely and completely');
  });

  it.each([
    ['control text', 'Read sums\nRisk: read', 'control characters'],
    [
      'credential-like text',
      'api_key=test-fixture-not-a-real-value',
      'cannot be displayed safely and completely',
    ],
  ])(
    'rejects an unsafe %s display name before approval',
    async (_case, displayName, error) => {
      await expect(
        buildReviewedMcpCapabilityCandidate({
          mcpServers: repositoryFor({
            appId: 'app:unsafe-display',
            allowedToolPatterns: ['get-sum'],
          }),
          appId: 'app:unsafe-display' as never,
          agentId: 'agent:test' as never,
          serverName: 'sum',
          tools: ['get-sum'],
          risk: 'read',
          displayName,
        }),
      ).rejects.toThrow(error);
    },
  );
});
