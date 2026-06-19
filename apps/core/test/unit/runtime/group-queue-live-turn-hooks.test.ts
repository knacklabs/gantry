import { describe, expect, it, vi } from 'vitest';

import { createLiveTurnLocalRunnerHooks } from '@core/runtime/group-queue-live-turn-hooks.js';

describe('createLiveTurnLocalRunnerHooks', () => {
  it('writes matching live continuations and invokes the continuation handler', () => {
    const writeContinuationInput = vi.fn();
    const continuationHandler = vi.fn();
    const hooks = createLiveTurnLocalRunnerHooks({
      groupJid: 'group1@g.us',
      state: {
        active: true,
        idleWaiting: true,
        isTaskRun: false,
        workspaceFolder: '/tmp/workspace',
        threadId: 'topic-1',
        continuationHandler,
      },
      runnerControlPort: {
        writeContinuationInput,
        writeCloseSignal: vi.fn(),
      },
      closeStdin: vi.fn(),
      stopGroup: vi.fn(),
    });

    hooks.applyContinuation({
      text: 'continue',
      sequence: 7,
      threadId: 'topic-1',
    });

    expect(writeContinuationInput).toHaveBeenCalledWith({
      workspaceFolder: '/tmp/workspace',
      text: 'continue',
      sequence: 7,
      threadId: 'topic-1',
    });
    expect(continuationHandler).toHaveBeenCalledTimes(1);
  });

  it('ignores continuations for inactive, task, or mismatched-thread runs', () => {
    const writeContinuationInput = vi.fn();
    const state = {
      active: true,
      idleWaiting: true,
      isTaskRun: false,
      workspaceFolder: '/tmp/workspace',
      threadId: 'topic-1',
      continuationHandler: vi.fn(),
    };
    const hooks = createLiveTurnLocalRunnerHooks({
      groupJid: 'group1@g.us',
      state,
      runnerControlPort: {
        writeContinuationInput,
        writeCloseSignal: vi.fn(),
      },
      closeStdin: vi.fn(),
      stopGroup: vi.fn(),
    });

    hooks.applyContinuation({ text: 'wrong thread', sequence: 1 });
    state.isTaskRun = true;
    hooks.applyContinuation({
      text: 'task run',
      sequence: 2,
      threadId: 'topic-1',
    });
    state.isTaskRun = false;
    state.active = false;
    hooks.applyContinuation({
      text: 'inactive',
      sequence: 3,
      threadId: 'topic-1',
    });

    expect(writeContinuationInput).not.toHaveBeenCalled();
    expect(state.continuationHandler).not.toHaveBeenCalled();
  });

  it('delegates close and stop hooks to the queue callbacks', () => {
    const closeStdin = vi.fn();
    const stopGroup = vi.fn();
    const hooks = createLiveTurnLocalRunnerHooks({
      groupJid: 'group1@g.us',
      state: {
        active: true,
        idleWaiting: false,
        isTaskRun: false,
        workspaceFolder: '/tmp/workspace',
        threadId: null,
        continuationHandler: null,
      },
      runnerControlPort: {
        writeContinuationInput: vi.fn(),
        writeCloseSignal: vi.fn(),
      },
      closeStdin,
      stopGroup,
    });

    hooks.applyCloseStdin();
    hooks.applyStop();

    expect(closeStdin).toHaveBeenCalledTimes(1);
    expect(stopGroup).toHaveBeenCalledTimes(1);
  });
});
