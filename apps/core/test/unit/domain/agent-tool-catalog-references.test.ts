import { describe, expect, it, vi } from 'vitest';

import { ensureAgentToolCatalogItem } from '@core/domain/tools/agent-tool-catalog-references.js';
import type { ToolCatalogRepository } from '@core/domain/ports/repositories.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';

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
});
