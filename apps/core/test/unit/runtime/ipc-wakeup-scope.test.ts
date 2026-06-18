import { describe, expect, it } from 'vitest';

import { IpcWakeupScopeTracker } from '@core/runtime/ipc-wakeup-scope.js';

describe('IpcWakeupScopeTracker', () => {
  it('narrows a specific watcher wakeup to one folder and lane', () => {
    const tracker = new IpcWakeupScopeTracker();

    tracker.recordWakeup({
      workspaceFolder: 'main_agent',
      lane: 'permission-requests',
    });
    const plan = tracker.startPass();

    expect(plan.scope).toBe('hinted');
    expect(
      plan.shouldProcessRequestLane('main_agent', 'permission-requests'),
    ).toBe(true);
    expect(plan.shouldProcessRequestLane('main_agent', 'messages')).toBe(false);
    expect(
      plan.shouldProcessRequestLane('other_agent', 'permission-requests'),
    ).toBe(false);
  });

  it('keeps unidentified and fallback wakeups as full scans', () => {
    const tracker = new IpcWakeupScopeTracker();

    tracker.recordWakeup();

    const plan = tracker.startPass();
    expect(plan.scope).toBe('all');
    expect(plan.shouldProcessRequestLane('main_agent', 'messages')).toBe(true);
  });

  it('promotes concurrent unscoped wakeups to a full follow-up pass', () => {
    const tracker = new IpcWakeupScopeTracker();

    tracker.recordWakeup({
      workspaceFolder: 'main_agent',
      lane: 'messages',
    });
    tracker.startPass();
    tracker.recordWakeupDuringPass();
    tracker.scheduleFollowupPass();

    const followup = tracker.startPass();
    expect(followup.scope).toBe('all');
  });
});
