import { describe, expect, it, vi } from 'vitest';

import { ensureAgentToolCatalogItem } from '@core/domain/tools/agent-tool-catalog-references.js';
import type { ToolCatalogRepository } from '@core/domain/ports/repositories.js';
import type { ToolCatalogItem } from '@core/domain/tools/tools.js';
import { persistentPermissionToolId } from '@core/shared/agent-tool-references.js';
import { adminMcpToolIdForFullName } from '@core/shared/admin-mcp-tools.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';

describe('agent tool catalog references', () => {
  it('returns an existing seeded admin row without overwriting its curated fields', async () => {
    const existing: ToolCatalogItem = {
      id: 'tool:mcp__gantry__settings_desired_state' as never,
      appId: 'default' as never,
      name: 'mcp__gantry__settings_desired_state',
      kind: 'host',
      provider: 'gantry',
      displayName: 'Settings Desired State',
      description: 'Curated admin seed row.',
      category: 'admin',
      risk: 'low',
      selectable: true,
      status: 'active',
      adapterRef: 'builtin:mcp__gantry__settings_desired_state',
      createdAt: '2026-05-01T00:00:00.000Z' as never,
      updatedAt: '2026-05-01T00:00:00.000Z' as never,
    };
    const saveTool = vi.fn(async () => undefined);
    const repository = {
      listTools: vi.fn(async () => []),
      getTool: vi.fn(async () => existing),
      saveTool,
    } as unknown as ToolCatalogRepository;

    const item = await ensureAgentToolCatalogItem({
      repository,
      appId: 'default' as never,
      reference: 'mcp__gantry__settings_desired_state',
      now: '2026-07-26T00:00:00.000Z',
    });

    expect(item).toBe(existing);
    expect(item).toMatchObject({
      category: 'admin',
      risk: 'low',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    expect(saveTool).not.toHaveBeenCalled();
  });

  it('returns an existing seeded scheduler row without creating a duplicate', async () => {
    const rule = 'mcp__gantry__scheduler_run_now';
    const existing: ToolCatalogItem = {
      id: adminMcpToolIdForFullName(rule) as never,
      appId: 'default' as never,
      name: rule,
      kind: 'host',
      provider: 'gantry',
      displayName: 'Run Job Now',
      description: 'Curated scheduler seed row.',
      category: 'admin',
      risk: 'high',
      selectable: true,
      status: 'active',
      adapterRef: `builtin:${rule}`,
      createdAt: '2026-05-01T00:00:00.000Z' as never,
      updatedAt: '2026-05-01T00:00:00.000Z' as never,
    };
    const saveTool = vi.fn(async () => undefined);
    const repository = {
      listTools: vi.fn(async () => []),
      getTool: vi.fn(async (toolId: string) =>
        toolId === existing.id ? existing : null,
      ),
      saveTool,
    } as unknown as ToolCatalogRepository;

    const item = await ensureAgentToolCatalogItem({
      repository,
      appId: 'default' as never,
      reference: rule,
      now: '2026-07-26T00:00:00.000Z',
    });

    expect(item).toBe(existing);
    expect(repository.getTool).toHaveBeenCalledWith(existing.id);
    expect(saveTool).not.toHaveBeenCalled();
  });

  it('creates separate active rows when two apps durably grant the same non-admin Gantry tool', async () => {
    const tools = new Map<string, ToolCatalogItem>();
    const saveTool = vi.fn(async (tool: ToolCatalogItem) => {
      tools.set(tool.id, tool);
    });
    const repository = {
      listTools: vi.fn(async ({ appId }: { appId: string }) =>
        [...tools.values()].filter((tool) => tool.appId === appId),
      ),
      getTool: vi.fn(async (toolId: string) => tools.get(toolId)),
      saveTool,
    } as unknown as ToolCatalogRepository;

    const rule = 'mcp__gantry__scheduler_resume_job';
    const appA = await ensureAgentToolCatalogItem({
      repository,
      appId: 'app:a' as never,
      reference: rule,
      now: '2026-07-26T00:00:00.000Z',
    });
    const appB = await ensureAgentToolCatalogItem({
      repository,
      appId: 'app:b' as never,
      reference: rule,
      now: '2026-07-26T00:00:00.000Z',
    });

    expect(appA).toMatchObject({
      id: persistentPermissionToolId('app:a', rule),
      appId: 'app:a',
      name: rule,
      status: 'active',
    });
    expect(appB).toMatchObject({
      id: persistentPermissionToolId('app:b', rule),
      appId: 'app:b',
      name: rule,
      status: 'active',
    });
    expect(appA.id).not.toBe(appB.id);
    expect(saveTool).toHaveBeenCalledTimes(2);
  });

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
});
