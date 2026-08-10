import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { PostgresToolCatalogRepository } from '@core/adapters/storage/postgres/repositories/tool-repository.postgres.js';
import { agentToolBindingsPostgres } from '@core/adapters/storage/postgres/schema/schema.js';
import { persistentPermissionBindingId } from '@core/application/permissions/permission-management-rules.js';

describe('agent_tool_bindings repository', () => {
  it('persists and reads a person-scoped binding distinct from a shared binding', async () => {
    const rows: Record<string, unknown>[] = [];
    const values = vi.fn((row: Record<string, unknown>) => ({
      onConflictDoUpdate: vi.fn(async () => {
        rows.push(row);
      }),
    }));
    const db = {
      insert: vi.fn(() => ({ values })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(async () => rows),
          })),
        })),
      })),
    };
    const repository = new PostgresToolCatalogRepository(db as never);
    const common = {
      appId: 'app:test',
      agentId: 'agent:test',
      toolId: 'tool:Browser',
      status: 'active' as const,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    };
    const sharedId = persistentPermissionBindingId(
      common.agentId,
      common.toolId,
      null,
    );
    const personBindingId = persistentPermissionBindingId(
      common.agentId,
      common.toolId,
      'person:alice',
    );

    await repository.saveAgentToolBinding({
      ...common,
      id: sharedId,
      personId: null,
    } as never);
    await repository.saveAgentToolBinding({
      ...common,
      id: personBindingId,
      personId: 'person:alice',
    } as never);

    await expect(
      repository.listAgentToolBindings({
        appId: common.appId as never,
        agentId: common.agentId as never,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ personId: null }),
      expect.objectContaining({ personId: 'person:alice' }),
    ]);
    expect(values).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ personId: null }),
    );
    expect(values).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ personId: 'person:alice' }),
    );
    expect(personBindingId).not.toBe(sharedId);
  });

  it('enforces one binding per agent, tool, config version, and person scope', () => {
    const constraint = getTableConfig(
      agentToolBindingsPostgres,
    ).uniqueConstraints.find(
      (candidate) => candidate.name === 'idx_agent_tool_bindings_unique',
    );

    expect(constraint?.columns.map((column) => column.name)).toEqual([
      'agent_id',
      'tool_id',
      'config_version_id',
      'person_id',
    ]);
    expect(constraint?.nullsNotDistinct).toBe(true);
  });
});
