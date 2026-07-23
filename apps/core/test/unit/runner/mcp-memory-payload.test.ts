import { describe, expect, it, vi } from 'vitest';

import {
  buildMemorySavePayload,
  buildProcedureSavePayload,
} from '@core/runner/mcp/tools/memory-payload.js';

describe('memory MCP payload helpers', () => {
  it('defaults memory_save to the conversation scope from runner context', () => {
    expect(
      buildMemorySavePayload(
        { key: 'preference:style', value: 'User prefers concise replies.' },
        { memoryDefaultScope: 'user', memoryUserId: 'u-1' },
      ),
    ).toMatchObject({ scope: 'user' });
    expect(
      buildMemorySavePayload(
        {
          key: 'preference:style',
          value: 'User prefers concise replies.',
          user_id: 'attacker',
        },
        { memoryDefaultScope: 'user', memoryUserId: 'u-1' },
      ),
    ).not.toHaveProperty('user_id');

    expect(
      buildMemorySavePayload(
        { key: 'decision:backend', value: 'Project uses Postgres.' },
        { memoryDefaultScope: 'group', memoryUserId: 'u-1' },
      ),
    ).toMatchObject({ scope: 'group' });
  });

  it('defaults procedure_save to the same conversation scope as memory_save', () => {
    expect(
      buildProcedureSavePayload(
        { title: 'Deploy', body: 'Run focused checks first.' },
        { memoryDefaultScope: 'user', memoryUserId: 'u-1' },
      ),
    ).toMatchObject({ scope: 'user' });
  });
});

describe('memory MCP tool schema', () => {
  it('advertises only canonical memory_save kinds', async () => {
    vi.resetModules();
    const originalIpcDir = process.env.GANTRY_IPC_DIR;
    process.env.GANTRY_IPC_DIR = '/tmp/gantry-mcp-memory-schema-test';
    const requestMemoryAction = vi.fn().mockResolvedValue({
      ok: true,
      provider: 'postgres',
      data: { review_page: { items: [] }, total_count: 0 },
    });
    vi.doMock('@core/runner/mcp/ipc.js', () => ({ requestMemoryAction }));
    try {
      const { registerMemoryTools } =
        await import('@core/runner/mcp/tools/memory.js');
      const schemas = new Map<string, Record<string, unknown>>();
      const descriptions = new Map<string, string>();
      const handlers = new Map<
        string,
        (args: Record<string, unknown>) => Promise<unknown>
      >();
      const server = {
        tool(
          name: string,
          description: string,
          schema: Record<string, unknown>,
          handler: (args: Record<string, unknown>) => Promise<unknown>,
        ) {
          schemas.set(name, schema);
          descriptions.set(name, description);
          handlers.set(name, handler);
        },
      };

      registerMemoryTools(server as Parameters<typeof registerMemoryTools>[0]);

      const memorySaveSchema = schemas.get('memory_save');
      expect(memorySaveSchema).toBeDefined();
      const kindSchema = memorySaveSchema?.kind as
        { unwrap: () => { options: string[] } } | undefined;
      expect(kindSchema?.unwrap().options).toEqual([
        'preference',
        'decision',
        'fact',
        'correction',
        'constraint',
      ]);
      expect(kindSchema?.unwrap().options).not.toContain('context');
      expect(kindSchema?.unwrap().options).not.toContain('recent_work');
      expect(schemas.has('procedure_save')).toBe(true);
      expect(schemas.has('procedure_patch')).toBe(true);
      expect(schemas.has('memory_demote')).toBe(true);
      expect(schemas.has('continuity_summary')).toBe(true);
      const pendingReviewSchema = schemas.get('memory_review_pending');
      expect(pendingReviewSchema?.limit).toBeDefined();
      expect(pendingReviewSchema?.offset).toBeDefined();
      expect(descriptions.get('memory_review_pending')).toContain(
        'review memories',
      );
      await handlers.get('memory_review_pending')?.({});
      expect(requestMemoryAction).toHaveBeenCalledWith(
        'memory_review_pending',
        expect.objectContaining({ limit: 10 }),
      );
      const reviewDecisionSchema = schemas.get('memory_review_decision');
      expect(reviewDecisionSchema?.review_id).toBeDefined();
      expect(reviewDecisionSchema?.decision).toBeDefined();
      expect(reviewDecisionSchema?.page_context).toBeDefined();
      expect(reviewDecisionSchema?.decisions).toBeDefined();
      expect(descriptions.get('memory_review_decision')).toContain(
        'only after the user gives explicit',
      );
    } finally {
      if (originalIpcDir === undefined) {
        delete process.env.GANTRY_IPC_DIR;
      } else {
        process.env.GANTRY_IPC_DIR = originalIpcDir;
      }
      vi.resetModules();
    }
  });
});
