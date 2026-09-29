import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { semanticCapabilityFromToolCatalogItem } from '@core/shared/semantic-capabilities.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('stored capability definitions (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'capability_binding_kind',
    });
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('rejects a stored definition with an unknown binding kind', async () => {
    const id = 'tool:capability:example.records.read';
    await runtime.repositories.tools.saveTool({
      id: id as never,
      appId: 'default' as never,
      name: 'capability:example.records.read',
      kind: 'host',
      provider: 'gantry',
      displayName: 'Example records read',
      category: 'productivity',
      risk: 'low',
      selectable: true,
      status: 'active',
      adapterRef: 'capability/example.records.read',
      inputSchema: {
        format: 'gantry.semantic-capability.v1',
        schema: {
          capabilityId: 'example.records.read',
          displayName: 'Example records read',
          category: 'Example',
          risk: 'read',
          can: 'Read records.',
          cannot: 'Change records.',
          credentialSource: 'none',
          implementationBindings: [{ kind: 'unknown_kind' }],
        },
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const stored = await runtime.repositories.tools.getTool(id as never);
    expect(stored).not.toBeNull();
    expect(
      semanticCapabilityFromToolCatalogItem({
        name: stored!.name,
        inputSchema: stored!.inputSchema,
      }),
    ).toBeUndefined();
  });
});
