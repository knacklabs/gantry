import { describe, expect, it } from 'vitest';

import {
  toPublicAsyncTaskDto,
  type AsyncTaskRecord,
} from '../../../src/domain/ports/async-tasks.js';

function task(receiptJson: AsyncTaskRecord['receiptJson']): AsyncTaskRecord {
  return {
    id: 'task-1',
    appId: 'app-1',
    agentId: 'agent-1',
    conversationId: 'conversation-1',
    kind: 'async_command',
    status: 'completed',
    admissionClass: 'task',
    authoritySnapshotJson: {},
    privateCorrelationJson: {},
    leaseToken: 'lease-1',
    fencingVersion: 1,
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:00.000Z',
    terminalAt: '2026-06-22T00:00:00.000Z',
    receiptJson,
  };
}

describe('toPublicAsyncTaskDto', () => {
  it('collapses pure answer receipts to one line', () => {
    expect(
      toPublicAsyncTaskDto(
        task({
          completed: 'answered',
          used: 'none',
          changed: 'none',
          delegated: 'no',
          needsAttention: 'none',
        }),
      ).receiptLines,
    ).toEqual(['Completed: answered']);
  });

  it('keeps full receipts when work used tools', () => {
    expect(
      toPublicAsyncTaskDto(
        task({
          completed: 'cancelled',
          used: 'RunCommand',
          changed: 'none',
          delegated: 'no',
          needsAttention: 'none',
        }),
      ).receiptLines,
    ).toEqual([
      'Completed: cancelled',
      'Used: RunCommand',
      'Changed: none',
      'Delegated: no',
      'Needs attention: none',
    ]);
  });
});
