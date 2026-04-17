import { describe, expect, it } from 'vitest';

import { BROWSER_IPC_ACTIONS, MEMORY_IPC_ACTIONS } from './index.js';

describe('contracts package', () => {
  it('exports memory IPC actions', () => {
    expect(MEMORY_IPC_ACTIONS).toEqual([
      'memory_search',
      'memory_save',
      'memory_patch',
      'memory_consolidate',
      'memory_dream',
      'procedure_save',
      'procedure_patch',
    ]);
  });

  it('exports browser IPC actions', () => {
    expect(BROWSER_IPC_ACTIONS).toEqual([
      'browser_profile_list',
      'browser_launch',
      'browser_close',
      'browser_status',
    ]);
  });
});
