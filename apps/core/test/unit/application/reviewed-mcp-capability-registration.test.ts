import { describe, expect, it, vi } from 'vitest';

import { registerReviewedMcpCapability } from '@core/application/agents/reviewed-mcp-capability-registration.js';
import type {
  McpServerRepository,
  ToolCatalogRepository,
} from '@core/domain/ports/repositories.js';

const capability = {
  capabilityId: 'firecrawl.scrape',
  displayName: 'Firecrawl scrape',
  category: 'Web research',
  risk: 'read' as const,
  can: 'Read a reviewed website through Firecrawl.',
  cannot: 'Access unrelated tools or credentials.',
  credentialSource: 'configured_access' as const,
  implementationBindings: [
    { kind: 'mcp_tool' as const, mcpTool: 'mcp__firecrawl__firecrawl_scrape' },
  ],
  preflight: { kind: 'none' as const },
};

describe('reviewed MCP capability registration', () => {
  it('upgrades an equivalent legacy exact MCP binding', async () => {
    const existing = {
      id: 'tool:capability:firecrawl.scrape',
      appId: 'manipal',
      name: 'capability:firecrawl.scrape',
      status: 'active',
      selectable: true,
      inputSchema: {
        format: 'gantry.semantic-capability.v1',
        schema: capability,
      },
    };
    const saveTool = vi.fn();
    const tools = {
      listTools: vi.fn(async () => [existing]),
      saveTool,
    } as unknown as ToolCatalogRepository;
    const mcpServers = {
      getServerByName: vi.fn(async () => ({
        id: 'mcp:firecrawl',
        appId: 'manipal',
        name: 'firecrawl',
        status: 'active',
        allowedToolPatterns: ['firecrawl_scrape'],
      })),
      appendAuditEvent: vi.fn(),
    } as unknown as McpServerRepository;

    const result = await registerReviewedMcpCapability({
      appId: 'manipal' as never,
      capability,
      repositories: { mcpServers, tools },
      now: '2026-08-04T00:00:00.000Z',
    });

    expect(saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool:capability:firecrawl.scrape',
        inputSchema: expect.objectContaining({
          schema: expect.objectContaining({
            implementationBindings: [
              {
                kind: 'mcp_pattern',
                mcpServer: 'firecrawl',
                mcpToolPatterns: ['firecrawl_scrape'],
              },
            ],
          }),
        }),
      }),
    );
    expect(result.inputSchema).toMatchObject({
      schema: {
        implementationBindings: [
          {
            kind: 'mcp_pattern',
            mcpServer: 'firecrawl',
            mcpToolPatterns: ['firecrawl_scrape'],
          },
        ],
      },
    });
  });

  it('rejects a source owned by another application', async () => {
    const appendAuditEvent = vi.fn();
    const mcpServers = {
      getServerByName: vi.fn(async () => ({
        id: 'mcp:firecrawl',
        appId: 'another-app',
        name: 'firecrawl',
        status: 'active',
        allowedToolPatterns: ['firecrawl_*'],
      })),
      appendAuditEvent,
    } as unknown as McpServerRepository;

    await expect(
      registerReviewedMcpCapability({
        appId: 'manipal' as never,
        capability,
        repositories: {
          mcpServers,
          tools: {
            listTools: vi.fn(async () => []),
          } as unknown as ToolCatalogRepository,
        },
        now: '2026-08-04T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(appendAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects invented or wildcard MCP tool bindings', async () => {
    await expect(
      registerReviewedMcpCapability({
        appId: 'manipal' as never,
        capability: {
          ...capability,
          implementationBindings: [
            { kind: 'mcp_tool', mcpTool: 'mcp__firecrawl__*' },
          ],
        },
        repositories: {
          mcpServers: {} as McpServerRepository,
          tools: {} as ToolCatalogRepository,
        },
        now: '2026-08-04T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
