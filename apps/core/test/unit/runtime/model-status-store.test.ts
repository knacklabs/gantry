import { describe, expect, it } from 'vitest';

import {
  getRuntimeModelStatus,
  updateRuntimeModelStatus,
} from '@core/runtime/model-status-store.js';

describe('runtime model status store', () => {
  it('evicts oldest snapshots when the store is bounded', () => {
    for (let i = 0; i < 501; i += 1) {
      updateRuntimeModelStatus({
        scopeKey: `scope-${i}`,
        selectionSource: 'chat default',
        modelAlias: 'sonnet',
      });
    }

    expect(getRuntimeModelStatus({ scopeKey: 'scope-0' })).toBeUndefined();
    expect(getRuntimeModelStatus({ scopeKey: 'scope-500' })).toBeDefined();
  });
});
