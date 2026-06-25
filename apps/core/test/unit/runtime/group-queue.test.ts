import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from '@core/runtime/group-queue.js';
import { activeRunStopWasRequested } from '@core/runtime/group-queue-stop.js';
import {
  createQueuedTask,
  dequeueTaskGroupByAdmissionClass,
} from '@core/runtime/runtime-admission.js';

// Mock config for DATA_DIR used by sendMessage/closeStdin helpers.
vi.mock('@core/config/index.js', () => ({
  DATA_DIR: '/tmp/gantry-test-data',
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // --- Single group at a time ---

  it('selects priority task groups from large backlogs without rotating the queue', () => {
    const waiting = Array.from({ length: 500 }, (_, i) => `maint-${i}`);
    waiting.push('child');
    const groups = new Map(
      waiting.map((groupJid) => [
        groupJid,
        {
          active: false,
          pendingTasks: [
            createQueuedTask(
              groupJid,
              `task-${groupJid}`,
              async () => {},
              groupJid === 'child' ? 'interactive_child' : 'maintenance',
            ),
          ],
        },
      ]),
    );

    expect(dequeueTaskGroupByAdmissionClass(waiting, groups)).toBe('child');
    expect(waiting[0]).toBe('maint-0');
  });

  it('only runs one run per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (_groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  it('registers live-turn runner hooks with routing metadata', async () => {
    const registrar = vi.fn();
    queue.setLiveTurnRunnerRegistrar(registrar);
    queue.setProcessMessagesFn(async (groupJid) => {
      queue.registerProcess(
        groupJid,
        { killed: false } as never,
        'run-1',
        '/workspace',
        ['alias-1'],
        null,
        { requiredContinuationUserId: 'user-1' },
      );
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(registrar).toHaveBeenCalledWith(
      'group1@g.us',
      expect.objectContaining({
        applyContinuation: expect.any(Function),
        applyCloseStdin: expect.any(Function),
        applyStop: expect.any(Function),
      }),
      {
        stopAliasJids: ['alias-1'],
        requiredContinuationUserId: 'user-1',
      },
    );
  });

  // --- Message concurrency limit ---

  it('respects message concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (_groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 4 groups (message pool limit is 3)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    queue.enqueueMessageCheck('group4@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 3 should be active (message pool limit)
    expect(maxActive).toBe(3);
    expect(activeCount).toBe(3);

    // Complete one — queued fourth should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(4);
  });

  it('uses injected message concurrency limits', async () => {
    queue = new GroupQueue({ maxMessageRuns: 1 });
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    queue.setProcessMessagesFn(async () => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(maxActive).toBe(1);

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(maxActive).toBe(1);
  });

  it('keeps message backlog unlimited when maxMessageBacklog is 0', async () => {
    queue = new GroupQueue({ maxMessageRuns: 1, maxMessageBacklog: 0 });
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    queue.setProcessMessagesFn(async (groupJid) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    queue.enqueueMessageCheck('group4@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us']);

    completionCallbacks.shift()?.();
    await vi.advanceTimersByTimeAsync(10);
    completionCallbacks.shift()?.();
    await vi.advanceTimersByTimeAsync(10);
    completionCallbacks.shift()?.();
    await vi.advanceTimersByTimeAsync(10);
    completionCallbacks.shift()?.();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual([
      'group1@g.us',
      'group2@g.us',
      'group3@g.us',
      'group4@g.us',
    ]);
  });

  it('defers new waiting message groups when message backlog cap is reached', async () => {
    queue = new GroupQueue({ maxMessageRuns: 1, maxMessageBacklog: 1 });
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    queue.setProcessMessagesFn(async (groupJid) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us']);

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);
    completionCallbacks[2]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us', 'group3@g.us']);
  });

  it('retains deferred message backlog work until capacity opens', async () => {
    queue = new GroupQueue({ maxMessageRuns: 1, maxMessageBacklog: 1 });
    const completionCallbacks: Array<() => void> = [];
    queue.setProcessMessagesFn(async () => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const groupsMap = (queue as any).groups as Map<string, unknown>;
    expect(groupsMap.has('group3@g.us')).toBe(true);

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);

    expect(groupsMap.has('group3@g.us')).toBe(true);
  });

  it('applies message backlog cap when task drains pending messages', async () => {
    queue = new GroupQueue({
      maxMessageRuns: 1,
      maxJobRuns: 2,
      maxMessageBacklog: 1,
    });
    const processedMessages: string[] = [];
    const messageCompletions: Array<() => void> = [];
    const taskCompletions: Array<() => void> = [];

    queue.setProcessMessagesFn(async (groupJid) => {
      processedMessages.push(groupJid);
      await new Promise<void>((resolve) => messageCompletions.push(resolve));
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueTask(
      'group2@g.us',
      'task-2',
      () => new Promise<void>((resolve) => taskCompletions.push(resolve)),
    );
    queue.enqueueTask(
      'group3@g.us',
      'task-3',
      () => new Promise<void>((resolve) => taskCompletions.push(resolve)),
    );
    await vi.advanceTimersByTimeAsync(10);

    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    taskCompletions[0]();
    await vi.advanceTimersByTimeAsync(10);
    taskCompletions[1]();
    await vi.advanceTimersByTimeAsync(10);

    const waitingMessageGroups = (queue as any)
      .waitingMessageGroups as string[];
    expect(waitingMessageGroups).toEqual(['group2@g.us']);
    expect(processedMessages).toEqual(['group1@g.us']);

    messageCompletions[0]();
    await vi.advanceTimersByTimeAsync(10);
    expect(processedMessages).toEqual(['group1@g.us', 'group2@g.us']);

    messageCompletions[1]();
    await vi.advanceTimersByTimeAsync(10);
    expect(processedMessages).toEqual([
      'group1@g.us',
      'group2@g.us',
      'group3@g.us',
    ]);
  });

  // --- Chat work prioritized over background tasks ---

  it('drains messages before background tasks for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (_groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('messages'); // chat drains before background
    expect(executionOrder[2]).toBe('task');
  });

  it('does not start a background task ahead of an already queued chat', async () => {
    queue = new GroupQueue({ maxMessageRuns: 1, maxJobRuns: 1 });
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    queue.setProcessMessagesFn(async (groupJid: string) => {
      if (groupJid === 'group1@g.us') {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push(`messages:${groupJid}`);
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.enqueueTask(
      'group2@g.us',
      'task-1',
      async () => {
        executionOrder.push('task:group2@g.us');
      },
      { admissionClass: 'background' },
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder).toEqual([]);

    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder).toEqual([
      'messages:group1@g.us',
      'messages:group2@g.us',
      'task:group2@g.us',
    ]);
  });

  it('drains interactive child tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    queue.setProcessMessagesFn(async () => {
      if (executionOrder.length === 0) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.enqueueTask(
      'group1@g.us',
      'task-1',
      async () => {
        executionOrder.push('task');
      },
      { admissionClass: 'interactive_child' },
    );
    queue.enqueueMessageCheck('group1@g.us');

    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder[0]).toBe('messages');
    expect(executionOrder[1]).toBe('task');
    expect(executionOrder[2]).toBe('messages');
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  it('uses injected retry policy without production backoff', async () => {
    queue = new GroupQueue({ baseRetryMs: 0, maxRetries: 2 });
    let callCount = 0;

    queue.setProcessMessagesFn(async () => {
      callCount++;
      return false;
    });

    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);

    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(3);
    expect(queue.getPolicy()).toMatchObject({ baseRetryMs: 0, maxRetries: 2 });
  });

  it('marks the last configured retry as final for message processing', async () => {
    queue = new GroupQueue({ baseRetryMs: 0, maxRetries: 2 });
    const finalRetryValues: boolean[] = [];

    queue.setProcessMessagesFn(async (_groupJid, context) => {
      finalRetryValues.push(context.finalRetry);
      return false;
    });

    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(1000);

    expect(finalRetryValues).toEqual([false, false, true]);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    expect(queue.isShuttingDown()).toBe(false);
    await queue.shutdown(0);
    expect(queue.isShuttingDown()).toBe(true);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill message pool (3 slots)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a fourth
    queue.enqueueMessageCheck('group4@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us', 'group3@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group4@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  it('rejects pending tasks when task backlog cap is reached', async () => {
    queue = new GroupQueue({ maxJobRuns: 1, maxTaskBacklog: 1 });
    let resolveTask: () => void;
    const firstTask = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    const secondTask = vi.fn(async () => {});
    const thirdTask = vi.fn(async () => {});

    expect(queue.enqueueTask('group1@g.us', 'task-1', firstTask)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.enqueueTask('group2@g.us', 'task-2', secondTask)).toBe(true);
    expect(queue.enqueueTask('group3@g.us', 'task-3', thirdTask)).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    expect(secondTask).toHaveBeenCalledTimes(1);
    expect(thirdTask).not.toHaveBeenCalled();
  });

  it('does not retain empty groups for rejected task backlog work', async () => {
    queue = new GroupQueue({ maxJobRuns: 1, maxTaskBacklog: 1 });
    let resolveTask: () => void;
    const firstTask = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    expect(queue.enqueueTask('group1@g.us', 'task-1', firstTask)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.enqueueTask('group2@g.us', 'task-2', async () => {})).toBe(
      true,
    );
    expect(queue.enqueueTask('group3@g.us', 'task-3', async () => {})).toBe(
      false,
    );

    const groupsMap = (queue as any).groups as Map<string, unknown>;
    expect(groupsMap.has('group3@g.us')).toBe(false);

    resolveTask!();
  });

  // --- Idle preemption ---

  it('does NOT preempt active agent run when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a workspaceFolder
    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');

    // Enqueue a task while agent run is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (run is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle agent run when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (agent run is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('pipes follow-up messages into an idle-waiting live run', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');

    // Run becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message continues the live SDK stream after the prior turn.
    const piped = queue.sendMessage('group1@g.us', 'hello');
    expect(piped).toBe(true);

    // enqueueMessageCheck while active records pending work without closing the
    // stream; task runs still preempt when the live run is idle again.
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');
    const closeFromPendingMessage = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeFromPendingMessage).toHaveLength(0);

    writeFileSync.mockClear();
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    const closeWritesAfterTask = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWritesAfterTask).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resumes an idle-waiting live message run', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');
    queue.notifyIdle('group1@g.us');

    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(true);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('notifies the active run when a continuation message is piped', async () => {
    let resolveProcess: () => void;
    const continuationHandler = vi.fn();

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');
    queue.registerContinuationHandler('group1@g.us', continuationHandler);
    queue.notifyIdle('group1@g.us');

    expect(queue.sendMessage('group1@g.us', 'hello')).toBe(true);
    expect(continuationHandler).toHaveBeenCalledTimes(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('task enqueue after queued idle messages preempts with a single close write', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');
    queue.notifyIdle('group1@g.us');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();
    queue.enqueueMessageCheck('group1@g.us');
    const firstCloseWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(firstCloseWrites).toHaveLength(0);

    writeFileSync.mockClear();
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    const secondCloseWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(secondCloseWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task agent runs so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskRun = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');

    // sendMessage should return false — user messages must not go to task agent runs
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('cleans up idle scheduler queue groups after tasks complete', async () => {
    const taskCount = 20;

    for (let i = 0; i < taskCount; i++) {
      const jid = `__scheduler__:primary:job-${i}`;
      queue.enqueueTask(jid, `task-${i}`, async () => {});
    }

    await vi.advanceTimersByTimeAsync(50);

    const groupsMap = (queue as any).groups as Map<string, unknown>;
    const schedulerKeys = Array.from(groupsMap.keys()).filter((key) =>
      key.startsWith('__scheduler__:'),
    );
    expect(schedulerKeys).toHaveLength(0);
  });

  // --- Coverage for drainGroup line 230 ---

  it('drainGroup triggers after runForGroup completes', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (_groupJid: string) => {
      if (executionOrder.length === 0) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start first message processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a second message while first is active
    queue.enqueueMessageCheck('group1@g.us');

    // Complete first — drainGroup should trigger second run
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder.length).toBeGreaterThanOrEqual(2);
    expect(executionOrder[1]).toBe('messages');
  });

  // --- Coverage for drainWaiting with messages (line 337) ---

  it('drainWaiting runs pending messages for waiting groups when slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill message pool (3 slots)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue messages for group4 (goes to waiting)
    queue.enqueueMessageCheck('group4@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us', 'group3@g.us']);

    // Complete group1 — group4 should drain via drainWaiting with messages path
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group4@g.us');
  });

  // --- Task/message budget split ---

  it('runs tasks even when message pool is saturated', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill message pool (3 slots)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a task for another group — should still run immediately.
    const taskExecuted = vi.fn();
    queue.enqueueTask('group4@g.us', 'task-not-starved', async () => {
      taskExecuted();
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(taskExecuted).toHaveBeenCalledTimes(1);
  });

  it('runs messages while background and maintenance task lanes are saturated', async () => {
    queue = new GroupQueue({ maxJobRuns: 1, maxMessageRuns: 1 });
    let completeTask: () => void;
    queue.enqueueTask(
      'job-group@g.us',
      'background-task',
      async () => {
        await new Promise<void>((resolve) => {
          completeTask = resolve;
        });
      },
      { admissionClass: 'background' },
    );
    queue.enqueueTask(
      'maintenance-group@g.us',
      'maintenance-task',
      async () => {},
      { admissionClass: 'maintenance' },
    );
    await vi.advanceTimersByTimeAsync(10);

    const processed: string[] = [];
    queue.setProcessMessagesFn(async (groupJid) => {
      processed.push(groupJid);
      return true;
    });

    queue.enqueueMessageCheck('chat-group@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['chat-group@g.us']);

    completeTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('prioritizes interactive child and background task work before maintenance', async () => {
    queue = new GroupQueue({ maxJobRuns: 1 });
    let completeTask: () => void;
    queue.enqueueTask('active-group@g.us', 'active-task', async () => {
      await new Promise<void>((resolve) => {
        completeTask = resolve;
      });
    });
    await vi.advanceTimersByTimeAsync(10);

    const order: string[] = [];
    queue.enqueueTask(
      'maintenance-group@g.us',
      'maintenance-task',
      async () => {
        order.push('maintenance');
      },
      { admissionClass: 'maintenance' },
    );
    queue.enqueueTask('background-group@g.us', 'background-task', async () => {
      order.push('background');
    });
    queue.enqueueTask(
      'child-group@g.us',
      'interactive-child-task',
      async () => {
        order.push('interactive_child');
      },
      { admissionClass: 'interactive_child' },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual([]);

    completeTask!();
    await vi.advanceTimersByTimeAsync(10);

    expect(order).toEqual(['interactive_child', 'background', 'maintenance']);
  });

  // --- Coverage for shutdown with active processes (lines 355-356) ---

  it('shutdown signals active message runs to close before waiting', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process with a host run handle
    const mockProcess = { killed: false } as any;
    queue.registerProcess('group1@g.us', mockProcess, 'run-active', 'team');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // Shutdown should request a graceful runner close without killing the process.
    await queue.shutdown(0);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);
    expect(mockProcess.killed).toBe(false);

    // After shutdown, new enqueues should be ignored
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(100);
    expect(processMessages).toHaveBeenCalledTimes(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('shutdown waits for active runs within the grace period', async () => {
    let resolveProcess: () => void;
    let shutdownResolved = false;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const shutdownPromise = queue.shutdown(5000).then(() => {
      shutdownResolved = true;
    });
    await Promise.resolve();
    expect(shutdownResolved).toBe(false);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
    await shutdownPromise;
    expect(shutdownResolved).toBe(true);
  });

  // --- Coverage for runTask error handling ---

  it('runTask handles task function errors without crashing', async () => {
    const taskFn = vi.fn(async () => {
      throw new Error('task execution failure');
    });

    queue.enqueueTask('group1@g.us', 'task-error', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Task should have been called and error should be caught
    expect(taskFn).toHaveBeenCalledTimes(1);

    // Queue should recover — enqueue another task for the same group
    const secondTaskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-recover', secondTaskFn);
    await vi.advanceTimersByTimeAsync(10);

    expect(secondTaskFn).toHaveBeenCalledTimes(1);
  });

  // --- Coverage for runForGroup error handling in processMessagesFn ---

  it('schedules retry when processMessagesFn throws', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('processing crash');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call throws
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry should occur after BASE_RETRY_MS
    await vi.advanceTimersByTimeAsync(5010);
    expect(callCount).toBe(2);
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now agent run becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('returns false when a task is enqueued after shutdown starts', async () => {
    await queue.shutdown(0);

    const taskFn = vi.fn(async () => {});
    const accepted = queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    expect(accepted).toBe(false);
    expect(taskFn).not.toHaveBeenCalled();
  });

  // --- Coverage for sendMessage returning false when not active ---

  it('sendMessage returns false when no agent run is active for the group', () => {
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);
  });

  it('sendMessage returns false when active but no workspaceFolder registered', async () => {
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Active but no registerProcess called (no workspaceFolder)
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for closeStdin when not active ---

  it('closeStdin does nothing when no agent run is active', async () => {
    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    queue.closeStdin('group1@g.us');

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && (call[0] as string).endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);
  });

  // --- Coverage for enqueueTask when shuttingDown ---

  it('enqueueTask does nothing after shutdown', async () => {
    const taskFn = vi.fn(async () => {});

    await queue.shutdown(0);
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(100);

    expect(taskFn).not.toHaveBeenCalled();
  });

  // --- Coverage for drainWaiting skipping group with neither tasks nor messages ---

  it('drainWaiting skips waiting groups with no pending tasks or messages', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue group3 with messages (goes to waiting)
    queue.enqueueMessageCheck('group3@g.us');
    // Also enqueue group4 with messages
    queue.enqueueMessageCheck('group4@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Complete both active groups
    completionCallbacks[0]();
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);

    // Both group3 and group4 should eventually be processed
    expect(processed).toContain('group3@g.us');
    expect(processed).toContain('group4@g.us');
  });

  // --- Coverage for drainGroup when shuttingDown ---

  it('drainGroup does not drain after shutdown', async () => {
    let resolveProcess: () => void;
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
      }
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start first group processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a second message while first is active
    queue.enqueueMessageCheck('group1@g.us');

    // Shutdown while first is still running
    await queue.shutdown(0);

    // Complete first — drainGroup should see shuttingDown and skip
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);

    // Only the first call should have happened; drain should not fire the second
    expect(callCount).toBe(1);
  });

  // --- Coverage for duplicate task already queued ---

  it('rejects duplicate enqueue of an already-queued task', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue task while active
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-dup', taskFn);

    // Try to enqueue the same task again
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-dup', dupFn);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);

    // Original task should have run, duplicate should not
    expect(taskFn).toHaveBeenCalledTimes(1);
    expect(dupFn).not.toHaveBeenCalled();
  });

  // --- Coverage for retry timeout not firing after shutdown ---

  it('retry timer does not fire after shutdown', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Shutdown before retry fires
    await queue.shutdown(1000);

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(10000);

    // Should not have retried after shutdown
    expect(callCount).toBe(1);
  });

  // --- Coverage for enqueueTask at concurrency limit ---

  it('enqueueTask queues task when at concurrency limit', async () => {
    const taskCompletionCallbacks: Array<() => void> = [];

    const blockingTask = () =>
      new Promise<void>((resolve) => taskCompletionCallbacks.push(resolve));

    // Fill task pool (4 slots) with long-running tasks.
    queue.enqueueTask('group1@g.us', 'task-1', blockingTask);
    queue.enqueueTask('group2@g.us', 'task-2', blockingTask);
    queue.enqueueTask('group3@g.us', 'task-3', blockingTask);
    queue.enqueueTask('group4@g.us', 'task-4', blockingTask);
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a fifth task at task concurrency limit.
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group5@g.us', 'task-limit', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Task should not have run yet
    expect(taskFn).not.toHaveBeenCalled();

    // Free one task slot.
    taskCompletionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    // Now queued task should run.
    expect(taskFn).toHaveBeenCalledTimes(1);
  });

  // --- Coverage for sendMessage success path ---

  it('sendMessage returns true and writes IPC file for active message agent run', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const renameSync = vi.mocked(fs.default.renameSync);
    writeFileSync.mockClear();
    renameSync.mockClear();

    const result = queue.sendMessage('group1@g.us', 'hello world');
    expect(result).toBe(true);

    // Should have written a temp file and renamed it
    expect(writeFileSync).toHaveBeenCalled();
    expect(renameSync).toHaveBeenCalled();

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage rejects continuations for a different active thread', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us::thread:thread-a');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us::thread:thread-a',
      {} as any,
      'run-1',
      'test-group',
      'group1@g.us',
      'thread-a',
    );

    expect(
      queue.sendMessage('group1@g.us::thread:thread-a', 'same thread', {
        threadId: 'thread-a',
      }),
    ).toBe(true);
    expect(
      queue.sendMessage('group1@g.us::thread:thread-a', 'other thread', {
        threadId: 'thread-b',
      }),
    ).toBe(false);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('requires the same sender for reviewer-authorized continuations', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'run-1',
      'test-group',
      undefined,
      null,
      { requiredContinuationUserId: 'sl:UADMIN' },
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    expect(
      queue.sendMessage('group1@g.us', 'approve 1', {
        senderUserIds: ['sl:UADMIN'],
      }),
    ).toBe(true);
    expect(
      queue.sendMessage('group1@g.us', 'approve 2', {
        senderUserIds: ['sl:UOTHER'],
      }),
    ).toBe(false);
    expect(
      queue.sendMessage('group1@g.us', 'approve 3', {
        senderUserIds: ['sl:UADMIN', 'sl:UOTHER'],
      }),
    ).toBe(false);
    expect(queue.sendMessage('group1@g.us', 'approve 4')).toBe(false);

    expect(writeFileSync).toHaveBeenCalledTimes(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('[BUG-TEST-002-CONTINUATION-FIFO] same-millisecond continuation IPC filenames preserve FIFO order', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');

    vi.spyOn(Date, 'now').mockReturnValue(1_776_438_800_000);
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.9).mockReturnValueOnce(0.1);
    const renameSync = vi.mocked(fs.default.renameSync);
    renameSync.mockClear();

    expect(queue.sendMessage('group1@g.us', 'first')).toBe(true);
    expect(queue.sendMessage('group1@g.us', 'second')).toBe(true);

    const finalPaths = renameSync.mock.calls.map((call) => String(call[1]));
    expect([...finalPaths].sort()).toEqual(finalPaths);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for sendMessage catch block ---

  it('sendMessage returns false when file write throws', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess('group1@g.us', {} as any, 'run-1', 'test-group');

    const mkdirSync = vi.mocked(fs.default.mkdirSync);
    mkdirSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for enqueueTask when task is already running (line 96-98) ---

  it('enqueueTask skips when same taskId is already running', async () => {
    let resolveTask: () => void;
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task — it will be running (runningTaskId set)
    queue.enqueueTask('group1@g.us', 'task-dup-running', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Try to enqueue the same taskId while it is still running
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-dup-running', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate should never be called
    expect(dupFn).not.toHaveBeenCalled();
    expect(taskFn).toHaveBeenCalledTimes(1);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for drainGroup pending messages after task completes (line 306) ---

  it('drainGroup runs pending messages after a task completes', async () => {
    let resolveTask: () => void;
    const taskRan = vi.fn();
    const taskFn = async () => {
      taskRan();
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    };

    const processed: string[] = [];
    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      return true;
    });
    queue.setProcessMessagesFn(processMessages);

    // Start a task for group1 (takes the slot)
    queue.enqueueTask('group1@g.us', 'task-before-msg', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskRan).toHaveBeenCalledTimes(1);

    // While the task is running, enqueue a message for the SAME group
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Messages should not have been processed yet (task is active)
    expect(processed).toHaveLength(0);

    // Complete the task — drainGroup should see pendingMessages and call runForGroup
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group1@g.us');
  });

  // --- Coverage for drainWaiting with tasks for waiting group (line 330) ---

  it('drainWaiting picks up pending tasks from waiting groups', async () => {
    const taskCompletionCallbacks: Array<() => void> = [];
    const blockingTask = () =>
      new Promise<void>((resolve) => taskCompletionCallbacks.push(resolve));

    // Fill task pool (4 slots) with running tasks.
    queue.enqueueTask('group1@g.us', 'task-1', blockingTask);
    queue.enqueueTask('group2@g.us', 'task-2', blockingTask);
    queue.enqueueTask('group3@g.us', 'task-3', blockingTask);
    queue.enqueueTask('group4@g.us', 'task-4', blockingTask);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCompletionCallbacks).toHaveLength(4);

    // Enqueue a task for a new group — goes to waiting since task pool is full.
    const waitingTaskFn = vi.fn(async () => {});
    queue.enqueueTask('group5@g.us', 'task-drain-waiting', waitingTaskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(waitingTaskFn).not.toHaveBeenCalled();

    // Complete group1 task — drainWaiting should pick up group5 task
    taskCompletionCallbacks[0]!();
    await vi.advanceTimersByTimeAsync(10);
    expect(waitingTaskFn).toHaveBeenCalledTimes(1);
  });

  // --- Coverage for drainWaiting with messages for waiting group (line 337) ---

  it('drainWaiting picks up pending messages from waiting groups', async () => {
    const completionCallbacks: Array<() => void> = [];
    const processed: string[] = [];
    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });
    queue.setProcessMessagesFn(processMessages);

    // Fill message pool (3 slots)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(completionCallbacks).toHaveLength(3);

    // Enqueue messages for group4 — goes to waiting
    queue.enqueueMessageCheck('group4@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(processed).toEqual(['group1@g.us', 'group2@g.us', 'group3@g.us']);

    // Complete group1 — drainWaiting should pick up group4's messages
    completionCallbacks[0]!();
    await vi.advanceTimersByTimeAsync(10);
    expect(processed).toContain('group4@g.us');
  });

  it('stopGroup returns false when no active run exists', () => {
    expect(queue.stopGroup('group1@g.us')).toBe(false);
  });

  it('stopGroup can stop scheduler runs via any linked chat jid alias', async () => {
    let resolveTask: () => void;
    const blockingTask = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    const schedulerQueueJid = '__scheduler__:primary:job-1';
    queue.enqueueTask(schedulerQueueJid, 'job-1', blockingTask);
    await vi.advanceTimersByTimeAsync(10);

    const mockProcess = { pid: 9_999_991, killed: false, kill: vi.fn() } as any;
    queue.registerProcess(
      schedulerQueueJid,
      mockProcess,
      'run-scheduler-1',
      'main',
      ['group1@g.us', 'group2@g.us'],
    );

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    expect(queue.stopGroup('group2@g.us')).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-9_999_991, 'SIGTERM');
    killSpy.mockRestore();

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('stopGroup sends SIGTERM to the active process group', async () => {
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const mockProcess = { pid: 9_999_992, killed: false, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', mockProcess, 'run-1', 'team');

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    expect(queue.stopGroup('group1@g.us')).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(-9_999_992, 'SIGTERM');
    expect(activeRunStopWasRequested(mockProcess)).toBe(true);
    killSpy.mockRestore();

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('stopGroup falls back to SIGTERM on the direct process when group kill fails', async () => {
    let resolveProcess: () => void;
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const mockProcess = { pid: 9_999_993, killed: false, kill: vi.fn() } as any;
    queue.registerProcess('group1@g.us', mockProcess, 'run-1', 'team');

    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementationOnce(() => {
        throw new Error('no process group');
      })
      .mockReturnValueOnce(true as never);
    expect(queue.stopGroup('group1@g.us')).toBe(true);
    expect(killSpy).toHaveBeenNthCalledWith(1, -9_999_993, 'SIGTERM');
    expect(killSpy).toHaveBeenNthCalledWith(2, 9_999_993, 'SIGTERM');
    killSpy.mockRestore();

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
