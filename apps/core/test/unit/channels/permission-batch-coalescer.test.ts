import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PERMISSION_BATCH_WINDOW_MS,
  PermissionBatchCoalescer,
  isDenyOrCancelDecision,
} from '@core/channels/permission-batch-coalescer.js';
import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '@core/domain/types.js';

function request(
  requestId: string,
  overrides: Partial<PermissionApprovalRequest> = {},
): PermissionApprovalRequest {
  return {
    requestId,
    responseNonce: `nonce-${requestId}`,
    sourceAgentFolder: 'main_agent',
    targetJid: 'tg:team',
    threadId: 'thread-1',
    runId: 'run-1',
    decisionPolicy: 'same_channel',
    toolName: 'Bash',
    ...overrides,
  };
}

describe('PermissionBatchCoalescer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('groups matching requests that arrive within the 1500ms window', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const first = request('permission-1');
    const second = request('permission-2');

    coalescer.enqueue(first);
    vi.advanceTimersByTime(DEFAULT_PERMISSION_BATCH_WINDOW_MS - 1);
    coalescer.enqueue(second);

    expect(flushed).toHaveLength(0);
    vi.advanceTimersByTime(1);

    expect(flushed).toEqual([[first, second]]);
    expect(flushed[0]?.map((entry) => entry.responseNonce)).toEqual([
      'nonce-permission-1',
      'nonce-permission-2',
    ]);
    expect(coalescer.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('separates requests with mismatched batch identity fields', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const base = request('base');
    const mismatches = [
      request('source', { sourceAgentFolder: 'other_agent' }),
      request('target', { targetJid: 'tg:other' }),
      request('thread', { threadId: 'thread-2' }),
      request('run', { runId: 'run-2' }),
      request('policy', { decisionPolicy: 'control_allowlist' }),
    ];

    coalescer.enqueue(base);
    for (const entry of mismatches) coalescer.enqueue(entry);
    vi.advanceTimersByTime(DEFAULT_PERMISSION_BATCH_WINDOW_MS);

    expect(
      flushed.map((batch) => batch.map((entry) => entry.requestId)),
    ).toEqual([
      ['base'],
      ['source'],
      ['target'],
      ['thread'],
      ['run'],
      ['policy'],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes all pending batches and clears timers on deny or cancel decisions', () => {
    vi.useFakeTimers();
    const coalescer = new PermissionBatchCoalescer();
    const first = request('permission-1');
    const second = request('permission-2', { targetJid: 'tg:other' });

    coalescer.enqueue(first);
    coalescer.enqueue(second);

    const flushed = coalescer.flushOnDecision({
      approved: false,
      mode: 'cancel',
      reason: 'user cancelled',
    });

    expect(flushed.map((batch) => batch.requests)).toEqual([[first], [second]]);
    expect(flushed.every((batch) => batch.reason === 'deny_or_cancel')).toBe(
      true,
    );
    expect(coalescer.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps pending batches on allow decisions', () => {
    vi.useFakeTimers();
    const flushed: PermissionApprovalRequest[][] = [];
    const coalescer = new PermissionBatchCoalescer({
      onFlush: (batch) => flushed.push(batch.requests),
    });
    const first = request('permission-1');

    coalescer.enqueue(first);
    expect(
      coalescer.flushOnDecision({ approved: true, mode: 'allow_once' }),
    ).toEqual([]);
    expect(coalescer.size()).toBe(1);

    vi.advanceTimersByTime(DEFAULT_PERMISSION_BATCH_WINDOW_MS);
    expect(flushed).toEqual([[first]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('classifies deny and cancel decisions as terminal batch flush semantics', () => {
    const decisions: PermissionApprovalDecision[] = [
      { approved: false, reason: 'deny' },
      { approved: false, mode: 'cancel' },
      { approved: true, mode: 'cancel' },
    ];

    expect(decisions.map(isDenyOrCancelDecision)).toEqual([true, true, true]);
    expect(isDenyOrCancelDecision({ approved: true, mode: 'allow_once' })).toBe(
      false,
    );
  });
});
