import { describe, expect, it, vi } from 'vitest';

import { PostgresMcpServerRepository } from '@core/adapters/storage/postgres/repositories/mcp-server-repository.postgres.js';

describe('PostgresMcpServerRepository capability approval locking', () => {
  it('lists the complete agent binding set when no page limit is requested', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `agent-mcp-binding:agent:test:mcp:${index}`,
      appId: 'app:test',
      agentId: 'agent:test',
      serverId: `mcp:${index}`,
      status: 'disabled',
      required: false,
      permissionPolicyIdsJson: '[]',
      allowedToolPatternsJson: '[]',
      conversationId: null,
      threadId: null,
      createdAt: `2026-07-21T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
      updatedAt: '2026-07-21T13:00:00.000Z',
    }));
    const limit = vi.fn(async () => rows.slice(0, 500));
    const query = {
      limit,
      then: (
        resolve: (value: typeof rows) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    const db = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => query,
          }),
        }),
      })),
    };
    const repository = new PostgresMcpServerRepository(db as never);

    const bindings = await repository.listAgentBindings({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
    });

    expect(bindings).toHaveLength(501);
    expect(bindings.at(-1)?.serverId).toBe('mcp:500');
    expect(limit).not.toHaveBeenCalled();
  });

  it('locks the agent binding set before inserting a binding', async () => {
    const agentLock = { for: vi.fn(async () => []) };
    const onConflictDoUpdate = vi.fn(async () => undefined);
    const tx = {
      select: vi.fn(() => ({
        from: () => ({ where: () => agentLock }),
      })),
      insert: vi.fn(() => ({
        values: () => ({ onConflictDoUpdate }),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresMcpServerRepository(db as never);

    await repository.saveAgentBinding({
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
    });

    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(agentLock.for.mock.invocationCallOrder[0]).toBeLessThan(
      tx.insert.mock.invocationCallOrder[0],
    );
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
  });

  it('locks the agent binding set before disabling a binding', async () => {
    const agentLock = { for: vi.fn(async () => []) };
    const returning = vi.fn(async () => []);
    const update = vi.fn(() => ({
      set: () => ({
        where: () => ({ returning }),
      }),
    }));
    const tx = {
      select: vi.fn(() => ({
        from: () => ({ where: () => agentLock }),
      })),
      update,
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresMcpServerRepository(db as never);

    await repository.disableAgentBinding({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      serverId: 'mcp:sum' as never,
      updatedAt: '2026-07-21T12:00:00.000Z',
    });

    expect(agentLock.for).toHaveBeenCalledWith('update');
    expect(agentLock.for.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
    expect(returning).toHaveBeenCalledOnce();
  });

  it('reserves pool capacity by running only one long approval transaction at a time', async () => {
    const rowLock = {
      for: vi.fn(async () => []),
    };
    const tx = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => rowLock,
        }),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresMcpServerRepository(db as never);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];

    const first = repository.withMcpCapabilityApprovalLock({
      appId: 'app:test' as never,
      serverNames: ['sum'],
      operation: async () => {
        events.push('first-start');
        await firstGate;
        events.push('first-end');
        return 'first';
      },
    });
    const second = repository.withMcpCapabilityApprovalLock({
      appId: 'app:test' as never,
      serverNames: ['echo'],
      operation: async () => {
        events.push('second-start');
        return 'second';
      },
    });

    await vi.waitFor(() => expect(events).toEqual(['first-start']));
    expect(rowLock.for).toHaveBeenCalledWith('no key update');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ]);
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
    expect(db.transaction).toHaveBeenCalledTimes(2);
  });

  it('uses a shared server-definition lock while resolving MCP call authority', async () => {
    const rowLock = { for: vi.fn(async () => []) };
    const tx = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => rowLock,
        }),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresMcpServerRepository(db as never);
    const operation = vi.fn(async () => 'authorized');

    await expect(
      repository.withMcpCapabilityAuthorizationLock({
        appId: 'app:test' as never,
        operation,
      }),
    ).resolves.toBe('authorized');

    expect(rowLock.for).toHaveBeenCalledWith('share');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not reserve the whole pool for concurrent authorization locks', async () => {
    const rowLock = { for: vi.fn(async () => []) };
    const tx = {
      select: vi.fn(() => ({
        from: () => ({ where: () => rowLock }),
      })),
    };
    let activeTransactions = 0;
    let maxActiveTransactions = 0;
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) => {
          activeTransactions += 1;
          maxActiveTransactions = Math.max(
            maxActiveTransactions,
            activeTransactions,
          );
          try {
            return await operation(tx);
          } finally {
            activeTransactions -= 1;
          }
        },
      ),
    };
    const repository = new PostgresMcpServerRepository(db as never);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const authorizations = Array.from({ length: 20 }, (_, index) =>
      repository.withMcpCapabilityAuthorizationLock({
        appId: 'app:test' as never,
        operation: async () => {
          if (index === 0) await firstGate;
          return index;
        },
      }),
    );

    await vi.waitFor(() => expect(db.transaction).toHaveBeenCalledTimes(1));
    expect(maxActiveTransactions).toBe(1);
    releaseFirst();

    await expect(Promise.all(authorizations)).resolves.toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
    expect(db.transaction).toHaveBeenCalledTimes(20);
    expect(maxActiveTransactions).toBe(1);
  });

  it('does not queue MCP authorizations behind another app', async () => {
    const rowLock = { for: vi.fn(async () => []) };
    const tx = {
      select: vi.fn(() => ({
        from: () => ({ where: () => rowLock }),
      })),
    };
    const db = {
      transaction: vi.fn(
        async (operation: (transaction: typeof tx) => Promise<unknown>) =>
          operation(tx),
      ),
    };
    const repository = new PostgresMcpServerRepository(db as never);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = repository.withMcpCapabilityAuthorizationLock({
      appId: 'app:slow' as never,
      operation: async () => {
        await firstGate;
        return 'slow';
      },
    });
    const secondOperation = vi.fn(async () => 'independent');
    const second = repository.withMcpCapabilityAuthorizationLock({
      appId: 'app:independent' as never,
      operation: secondOperation,
    });

    await expect(second).resolves.toBe('independent');
    expect(secondOperation).toHaveBeenCalledOnce();
    releaseFirst();
    await expect(first).resolves.toBe('slow');
  });
});
