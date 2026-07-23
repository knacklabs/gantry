import { describe, expect, it, vi } from 'vitest';

import { ensureAgentToolCatalogItem } from '@core/domain/tools/agent-tool-catalog-references.js';
import type { ToolCatalogRepository } from '@core/domain/ports/repositories.js';
import {
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
} from '@core/shared/semantic-capabilities.js';

describe('agent tool catalog references', () => {
  it('refreshes semantic capability rows from supplied reviewed definitions instead of stale projections', async () => {
    const reviewedDefinition: SemanticCapabilityDefinition = {
      capabilityId: 'acme.records.append',
      displayName: 'Acme records append',
      category: 'Acme',
      risk: 'write',
      can: 'Append records.',
      cannot: 'Expose tokens.',
      credentialSource: 'local_cli',
      implementationBindings: [
        {
          kind: 'local_cli',
          executablePath: '/usr/local/bin/acme',
          executableVersion: '1.0.0',
          executableHash: 'sha256:abc123',
          commandTemplates: ['/usr/local/bin/acme records append *'],
        },
      ],
    };
    const saveTool = vi.fn(async () => undefined);
    const repository = {
      listTools: vi.fn(async () => [
        {
          appId: 'default',
          id: 'tool:capability:acme.records.append',
          name: 'capability:acme.records.append',
          selectable: true,
          status: 'active',
          inputSchema: {
            format: 'gantry.semantic-capability.v1',
            schema: {
              capabilityId: 'acme.records.append',
              displayName: 'Acme records append',
              category: 'Acme',
              risk: 'write',
              can: 'Append records.',
              cannot: 'Expose tokens.',
              credentialSource: 'configured_access',
              implementationBindings: [
                {
                  kind: 'tool_rule',
                  rule: 'RunCommand(model_gateway google sheets write *)',
                },
              ],
            },
          },
        },
      ]),
      getTool: vi.fn(async () => null),
      saveTool,
    } as unknown as ToolCatalogRepository;

    const item = await ensureAgentToolCatalogItem({
      repository,
      appId: 'default' as never,
      reference: 'capability:acme.records.append',
      now: '2026-05-16T00:00:00.000Z',
      semanticCapabilityDefinitions: {
        'acme.records.append': reviewedDefinition,
      },
    });

    expect(item.inputSchema).toMatchObject({
      schema: {
        capabilityId: 'acme.records.append',
        implementationBindings: [
          {
            kind: 'local_cli',
            commandTemplates: ['/usr/local/bin/acme records append *'],
          },
        ],
      },
    });
    expect(JSON.stringify(item.inputSchema)).not.toContain('model_gateway');
    expect(saveTool).toHaveBeenCalledWith(item);
  });

  it('atomically reuses a concurrent MCP proposal with the same authority', async () => {
    const requested: SemanticCapabilityDefinition = {
      capabilityId: 'mcp.sum.read.123456789abc',
      displayName: 'Requested sum reads',
      category: 'MCP',
      risk: 'read',
      can: 'Call reviewed sum MCP tools matching: get-sum.',
      cannot: 'Call other sum MCP tools or bypass the connected source scope.',
      credentialSource: 'none',
      implementationBindings: [
        {
          kind: 'mcp_pattern',
          mcpServer: 'sum',
          mcpToolPatterns: ['get-sum'],
        },
      ],
      preflight: { kind: 'none' },
      source: {
        kind: 'mcp_capability_proposal',
        serverId: 'mcp:sum',
        serverName: 'sum',
      },
    };
    const existing = {
      appId: 'app:test',
      id: `tool:capability:${requested.capabilityId}`,
      name: `capability:${requested.capabilityId}`,
      kind: 'host',
      provider: 'gantry',
      displayName: 'Existing sum reads',
      description: 'Existing reviewed definition.',
      category: 'productivity',
      risk: 'low',
      selectable: true,
      status: 'active',
      inputSchema: semanticCapabilityInputSchema({
        ...requested,
        displayName: 'Existing sum reads',
      }),
      adapterRef: `capability/${requested.capabilityId}`,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    };
    const saveTool = vi.fn(async () => undefined);
    const saveToolIfAbsent = vi.fn(async () => existing as never);

    const item = await ensureAgentToolCatalogItem({
      repository: {
        listTools: vi.fn(async () => []),
        getTool: vi.fn(async () => null),
        saveTool,
        saveToolIfAbsent,
      } as unknown as ToolCatalogRepository,
      appId: 'app:test' as never,
      reference: `capability:${requested.capabilityId}`,
      now: '2026-07-21T00:00:01.000Z',
      semanticCapabilityDefinitions: {
        [requested.capabilityId]: requested,
      },
    });

    expect(item.displayName).toBe('Existing sum reads');
    expect(saveToolIfAbsent).toHaveBeenCalledTimes(1);
    expect(saveTool).not.toHaveBeenCalled();
  });

  it.each([
    { state: 'inactive', status: 'disabled', selectable: true },
    { state: 'unselectable', status: 'active', selectable: false },
  ])('rejects an $state atomic MCP proposal winner', async (catalogState) => {
    const requested: SemanticCapabilityDefinition = {
      capabilityId: 'mcp.sum.read.123456789abc',
      displayName: 'Requested sum reads',
      category: 'MCP',
      risk: 'read',
      can: 'Call reviewed sum MCP tools matching: get-sum.',
      cannot: 'Call other sum MCP tools or bypass the connected source scope.',
      credentialSource: 'none',
      implementationBindings: [
        {
          kind: 'mcp_pattern',
          mcpServer: 'sum',
          mcpToolPatterns: ['get-sum'],
        },
      ],
      preflight: { kind: 'none' },
      source: {
        kind: 'mcp_capability_proposal',
        serverId: 'mcp:sum',
        serverName: 'sum',
      },
    };
    const blocked = {
      appId: 'app:test',
      id: `tool:capability:${requested.capabilityId}`,
      name: `capability:${requested.capabilityId}`,
      kind: 'host',
      provider: 'gantry',
      displayName: requested.displayName,
      description: 'Disabled reviewed definition.',
      category: 'productivity',
      risk: 'low',
      selectable: catalogState.selectable,
      status: catalogState.status,
      inputSchema: semanticCapabilityInputSchema(requested),
      adapterRef: `capability/${requested.capabilityId}`,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    };
    const saveTool = vi.fn(async () => undefined);

    await expect(
      ensureAgentToolCatalogItem({
        repository: {
          listTools: vi.fn(async () => []),
          getTool: vi.fn(async () => null),
          saveTool,
          saveToolIfAbsent: vi.fn(async () => blocked as never),
        } as unknown as ToolCatalogRepository,
        appId: 'app:test' as never,
        reference: `capability:${requested.capabilityId}`,
        now: '2026-07-21T00:00:01.000Z',
        semanticCapabilityDefinitions: {
          [requested.capabilityId]: requested,
        },
      }),
    ).rejects.toThrow('does not match the active catalog definition');

    expect(saveTool).not.toHaveBeenCalled();
  });
});
