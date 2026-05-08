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
    const originalIpcDir = process.env.MYCLAW_IPC_DIR;
    process.env.MYCLAW_IPC_DIR = '/tmp/myclaw-mcp-memory-schema-test';
    try {
      const { registerMemoryTools } =
        await import('@core/runner/mcp/tools/memory.js');
      const schemas = new Map<string, Record<string, unknown>>();
      const server = {
        tool(
          name: string,
          _description: string,
          schema: Record<string, unknown>,
          _handler: unknown,
        ) {
          schemas.set(name, schema);
        },
      };

      registerMemoryTools(server as Parameters<typeof registerMemoryTools>[0]);

      const memorySaveSchema = schemas.get('memory_save');
      expect(memorySaveSchema).toBeDefined();
      const kindSchema = memorySaveSchema?.kind as
        | { unwrap: () => { options: string[] } }
        | undefined;
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
    } finally {
      if (originalIpcDir === undefined) {
        delete process.env.MYCLAW_IPC_DIR;
      } else {
        process.env.MYCLAW_IPC_DIR = originalIpcDir;
      }
      vi.resetModules();
    }
  });
});
