import { describe, expect, it, vi } from 'vitest';

import { PostgresAgentRepository } from '@core/adapters/storage/postgres/repositories/agent-repository.postgres.js';
import { assertExpectedMcpBindingsUnchanged } from '@core/adapters/storage/postgres/repositories/mcp-binding-authority-fence.postgres.js';
import { agentToolBindingsPostgres } from '@core/adapters/storage/postgres/schema/schema.js';

describe('PostgresAgentRepository MCP binding fence', () => {
  it('upserts tool bindings on their database uniqueness scope', async () => {
    let selectCall = 0;
    const agentLock = { for: vi.fn(async () => []) };
    const mcpLock = { for: vi.fn(async () => []) };
    let conflict: Record<string, unknown> | undefined;
    const tx = {
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => {
              if (selectCall === 1) return agentLock;
              if (selectCall === 2) return mcpLock;
              if (selectCall === 5) {
                return { for: vi.fn(async () => []) };
              }
              return Promise.resolve([]);
            },
          }),
        };
      }),
      insert: vi.fn(() => ({
        values: () => ({
          onConflictDoUpdate: vi.fn(async (input: Record<string, unknown>) => {
            conflict = input;
          }),
        }),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresAgentRepository(db as never);

    await repository.replaceAgentCapabilityBindings({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      toolBindings: [
        {
          id: 'agent-tool-binding:new-id' as never,
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
          toolId: 'tool:test' as never,
          personId: null,
          configVersionId: null,
          status: 'active',
          createdAt: '2026-08-21T00:00:00.000Z',
          updatedAt: '2026-08-21T00:00:00.000Z',
        },
      ],
      skillBindings: [],
      mcpBindings: [],
      expectedMcpBindingAgentIds: ['agent:test' as never],
      expectedMcpBindings: [],
      updatedAt: '2026-08-21T00:00:00.000Z',
    });

    expect(conflict).toMatchObject({
      target: [
        agentToolBindingsPostgres.agentId,
        agentToolBindingsPostgres.toolId,
        agentToolBindingsPostgres.configVersionId,
        agentToolBindingsPostgres.personId,
      ],
    });
  });

  it('matches semantic authority without depending on Postgres timestamp text', async () => {
    let selectCall = 0;
    const agentLock = { for: vi.fn(async () => []) };
    const rowLock = {
      for: vi.fn(async () => [
        {
          id: 'agent-mcp-binding:agent:test:mcp:sum',
          appId: 'app:test',
          agentId: 'agent:test',
          serverId: 'mcp:sum',
          status: 'active',
          required: false,
          permissionPolicyIdsJson: '["policy:b","policy:a"]',
          allowedToolPatternsJson: '["echo","get-sum","echo"]',
          conversationId: null,
          threadId: null,
          updatedAt: '2026-07-21 12:00:00+00',
        },
      ]),
    };
    const tx = {
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => (selectCall === 1 ? agentLock : rowLock),
          }),
        };
      }),
    };

    await expect(
      assertExpectedMcpBindingsUnchanged(tx as never, {
        appId: 'app:test',
        expectedMcpBindings: [
          {
            id: 'agent-mcp-binding:agent:test:mcp:sum' as never,
            appId: 'app:test' as never,
            agentId: 'agent:test' as never,
            serverId: 'mcp:sum' as never,
            status: 'active',
            required: false,
            permissionPolicyIds: ['policy:a', 'policy:b', 'policy:a'] as never,
            allowedToolPatterns: ['get-sum', 'echo'],
          },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(rowLock.for).toHaveBeenCalledWith('update');
  });

  it('rejects a concurrent addition to the fenced MCP binding set', async () => {
    let selectCall = 0;
    const agentLock = { for: vi.fn(async () => []) };
    const bindingLock = {
      for: vi.fn(async () => [
        {
          id: 'agent-mcp-binding:agent:test:mcp:sum',
          appId: 'app:test',
          agentId: 'agent:test',
          serverId: 'mcp:sum',
          status: 'active',
          required: false,
          permissionPolicyIdsJson: '[]',
          allowedToolPatternsJson: '["get-sum"]',
          conversationId: null,
          threadId: null,
        },
        {
          id: 'agent-mcp-binding:agent:test:mcp:echo',
          appId: 'app:test',
          agentId: 'agent:test',
          serverId: 'mcp:echo',
          status: 'active',
          required: false,
          permissionPolicyIdsJson: '[]',
          allowedToolPatternsJson: '["echo"]',
          conversationId: null,
          threadId: null,
        },
      ]),
    };
    const tx = {
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => (selectCall === 1 ? agentLock : bindingLock),
          }),
        };
      }),
    };

    await expect(
      assertExpectedMcpBindingsUnchanged(tx as never, {
        appId: 'app:test',
        expectedMcpBindings: [
          {
            id: 'agent-mcp-binding:agent:test:mcp:sum' as never,
            appId: 'app:test' as never,
            agentId: 'agent:test' as never,
            serverId: 'mcp:sum' as never,
            status: 'active',
            required: false,
            permissionPolicyIds: [],
            allowedToolPatterns: ['get-sum'],
          },
        ],
      }),
    ).rejects.toThrow(
      'MCP source binding mcp:echo changed during capability approval',
    );
    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(bindingLock.for).toHaveBeenCalledWith('update');
  });

  it('rejects a concurrent addition when the reviewed binding set was empty', async () => {
    let selectCall = 0;
    const agentLock = { for: vi.fn(async () => []) };
    const bindingLock = {
      for: vi.fn(async () => [
        {
          id: 'agent-mcp-binding:agent:test:mcp:sum',
          appId: 'app:test',
          agentId: 'agent:test',
          serverId: 'mcp:sum',
          status: 'active',
          required: false,
          permissionPolicyIdsJson: '[]',
          allowedToolPatternsJson: '[]',
          conversationId: null,
          threadId: null,
        },
      ]),
    };
    const tx = {
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => (selectCall === 1 ? agentLock : bindingLock),
          }),
        };
      }),
    };

    await expect(
      assertExpectedMcpBindingsUnchanged(tx as never, {
        appId: 'app:test',
        expectedMcpBindingAgentIds: ['agent:test' as never],
        expectedMcpBindings: [],
      }),
    ).rejects.toThrow(
      'MCP source binding mcp:sum changed during capability approval',
    );
    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(bindingLock.for).toHaveBeenCalledWith('update');
  });

  it('saves fenced agents and validates the complete snapshot in one transaction', async () => {
    let selectCall = 0;
    const agentLock = { for: vi.fn(async () => []) };
    const bindingLock = { for: vi.fn(async () => []) };
    const onConflictDoUpdate = vi.fn(async () => undefined);
    const tx = {
      insert: vi.fn(() => ({
        values: () => ({ onConflictDoUpdate }),
      })),
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => (selectCall === 1 ? agentLock : bindingLock),
          }),
        };
      }),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresAgentRepository(db as never);

    await repository.replaceAgentCapabilityBindingsBatch({
      appId: 'app:test' as never,
      agents: [
        {
          id: 'agent:test' as never,
          appId: 'app:test' as never,
          name: 'Test',
          status: 'active',
          createdAt: '2026-07-21T12:00:00.000Z' as never,
          updatedAt: '2026-07-21T12:00:00.000Z' as never,
        },
      ],
      replacements: [],
      expectedMcpBindingAgentIds: ['agent:test' as never],
      expectedMcpBindings: [],
    });

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(tx.insert).toHaveBeenCalledOnce();
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(bindingLock.for).toHaveBeenCalledWith('update');
  });

  it('rejects desired-state persistence after the reviewed source binding changes', async () => {
    const lockedRows = [
      {
        id: 'agent-mcp-binding:agent:test:mcp:sum',
        appId: 'app:test',
        agentId: 'agent:test',
        serverId: 'mcp:sum',
        status: 'disabled',
        allowedToolPatternsJson: '["get-sum"]',
        updatedAt: '2026-07-21T12:01:00.000Z',
      },
    ];
    let selectCall = 0;
    const agentLock = { for: vi.fn(async () => []) };
    const rowLock = { for: vi.fn(async () => lockedRows) };
    const tx = {
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => (selectCall === 1 ? agentLock : rowLock),
          }),
        };
      }),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresAgentRepository(db as never);

    await expect(
      repository.replaceAgentCapabilityBindings({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        toolBindings: [],
        skillBindings: [],
        mcpBindings: [],
        expectedMcpBindings: [
          {
            id: 'agent-mcp-binding:agent:test:mcp:sum' as never,
            appId: 'app:test' as never,
            agentId: 'agent:test' as never,
            serverId: 'mcp:sum' as never,
            status: 'active',
            required: false,
            permissionPolicyIds: [],
            allowedToolPatterns: ['get-sum'],
            createdAt: '2026-07-21T12:00:00.000Z' as never,
            updatedAt: '2026-07-21T12:00:00.000Z' as never,
          },
        ],
        updatedAt: '2026-07-21T12:02:00.000Z',
      }),
    ).rejects.toThrow(
      'MCP source binding mcp:sum changed during capability approval',
    );
    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(rowLock.for).toHaveBeenCalledWith('update');
  });

  it('atomically preserves existing MCP policy while settings updates source scope', async () => {
    const existing = {
      id: 'agent-mcp-binding:agent:test:mcp:sum',
      appId: 'app:test',
      agentId: 'agent:test',
      serverId: 'mcp:sum',
      status: 'active',
      required: true,
      permissionPolicyIdsJson: '["policy:sum"]',
      allowedToolPatternsJson: '["get-sum"]',
      conversationId: 'conversation:sum',
      threadId: 'thread:sum',
      createdAt: '2026-07-21T11:00:00.000Z',
      updatedAt: '2026-07-21T11:00:00.000Z',
    };
    let selectCall = 0;
    const agentLock = { for: vi.fn(async () => []) };
    const mcpRowLock = { for: vi.fn(async () => [existing]) };
    let inserted: Record<string, unknown> | undefined;
    let updated: Record<string, unknown> | undefined;
    const tx = {
      select: vi.fn(() => {
        selectCall += 1;
        return {
          from: () => ({
            where: () => {
              if (selectCall === 1) return agentLock;
              return selectCall === 4 ? mcpRowLock : Promise.resolve([]);
            },
          }),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserted = value;
          return {
            onConflictDoUpdate: vi.fn(
              async (input: { set: Record<string, unknown> }) => {
                updated = input.set;
              },
            ),
          };
        }),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresAgentRepository(db as never);

    await repository.replaceAgentCapabilityBindings({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      toolBindings: [],
      skillBindings: [],
      mcpBindings: [
        {
          id: existing.id as never,
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
          serverId: 'mcp:sum' as never,
          status: 'active',
          required: false,
          permissionPolicyIds: [],
          allowedToolPatterns: ['get-sum', 'echo'],
          createdAt: '2026-07-21T12:00:00.000Z' as never,
          updatedAt: '2026-07-21T12:00:00.000Z' as never,
        },
      ],
      preserveExistingMcpPolicy: true,
      updatedAt: '2026-07-21T12:00:00.000Z',
    });

    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(mcpRowLock.for).toHaveBeenCalledWith('update');
    expect(inserted).toMatchObject({
      required: true,
      permissionPolicyIdsJson: '["policy:sum"]',
      allowedToolPatternsJson: '["get-sum","echo"]',
      conversationId: 'conversation:sum',
      threadId: 'thread:sum',
    });
    expect(updated).toMatchObject({
      required: true,
      permissionPolicyIdsJson: '["policy:sum"]',
      allowedToolPatternsJson: '["get-sum","echo"]',
      conversationId: 'conversation:sum',
      threadId: 'thread:sum',
    });
  });
});
