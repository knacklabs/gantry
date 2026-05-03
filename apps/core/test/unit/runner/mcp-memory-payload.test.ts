import { describe, expect, it } from 'vitest';

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
