import { describe, expect, it } from 'vitest';

import type { RegisteredGroup } from '@core/domain/types.js';
import { resolveIpcFoldersFromGroups } from '@core/runtime/ipc.js';

function group(folder: string): RegisteredGroup {
  return {
    name: folder,
    folder,
    trigger: '@Andy',
    added_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveIpcFoldersFromGroups', () => {
  it('returns only valid registered agent folders', () => {
    expect(
      resolveIpcFoldersFromGroups({
        'tg:1': group('kai_tg_1'),
        'tg:2': group('../escape'),
        'tg:3': group(''),
        'tg:4': group('valid_agent_folder'),
      }),
    ).toEqual(['kai_tg_1', 'valid_agent_folder']);
  });

  it('deduplicates folders shared by multiple bindings', () => {
    expect(
      resolveIpcFoldersFromGroups({
        'tg:1': group('kai_tg_1'),
        'tg:2': group('kai_tg_1'),
      }),
    ).toEqual(['kai_tg_1']);
  });
});
