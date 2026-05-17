import { describe, expect, it, vi } from 'vitest';

import { ensureAgentToolCatalogItem } from '@core/domain/tools/agent-tool-catalog-references.js';
import type { ToolCatalogRepository } from '@core/domain/ports/repositories.js';

describe('agent tool catalog references', () => {
  it('refreshes builtin semantic capability rows instead of reusing stale provider-specific projections', async () => {
    const saveTool = vi.fn(async () => undefined);
    const repository = {
      listTools: vi.fn(async () => [
        {
          appId: 'default',
          id: 'tool:capability:google.sheets.write',
          name: 'capability:google.sheets.write',
          selectable: true,
          status: 'active',
          inputSchema: {
            format: 'myclaw.semantic-capability.v1',
            schema: {
              capabilityId: 'google.sheets.write',
              displayName: 'Google Sheets write',
              category: 'Google Sheets',
              risk: 'write',
              can: 'Write sheets.',
              cannot: 'Expose tokens.',
              credentialSource: 'configured_access',
              implementationBindings: [
                {
                  kind: 'tool_rule',
                  rule: 'Bash(onecli google sheets write *)',
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
      reference: 'capability:google.sheets.write',
      now: '2026-05-16T00:00:00.000Z',
    });

    expect(item.inputSchema).toMatchObject({
      schema: {
        capabilityId: 'google.sheets.write',
        implementationBindings: [
          {
            kind: 'adapter',
            adapterRef: 'configured.google.sheets.write',
          },
        ],
      },
    });
    expect(JSON.stringify(item.inputSchema)).not.toContain('onecli');
    expect(saveTool).toHaveBeenCalledWith(item);
  });
});
