import { describe, expect, it } from 'vitest';

import { buildTaskLifecycleRuntimeEvent } from '@core/runner/task-lifecycle-events.js';

describe('buildTaskLifecycleRuntimeEvent', () => {
  const context = {
    appId: 'app-one',
    agentId: 'agent:one',
    runId: 'run-1',
    jobId: 'job-1',
    conversationId: 'tg:team',
    threadId: 'thread-1',
    actor: 'sdk',
  };

  it('maps canonical lifecycle kinds to task runtime events', () => {
    expect(
      buildTaskLifecycleRuntimeEvent(context, {
        kind: 'started',
        taskId: 'task-1',
      })?.eventType,
    ).toBe('task.started');
    expect(
      buildTaskLifecycleRuntimeEvent(context, {
        kind: 'progress',
        taskId: 'task-1',
      })?.eventType,
    ).toBe('task.progress');
    expect(
      buildTaskLifecycleRuntimeEvent(context, {
        kind: 'updated',
        taskId: 'task-1',
      })?.eventType,
    ).toBe('task.updated');
    expect(
      buildTaskLifecycleRuntimeEvent(context, {
        kind: 'notification',
        taskId: 'task-1',
      })?.eventType,
    ).toBe('task.notification');
  });

  it('keeps only sanitized lifecycle payload fields', () => {
    const event = buildTaskLifecycleRuntimeEvent(context, {
      kind: 'updated',
      taskId: 'task-1',
      toolUseId: 'toolu-1',
      patch: {
        status: 'running',
        description: 'Research',
        endTime: 123,
        totalPausedMs: 0,
        isBackgrounded: true,
        hasError: true,
      },
      prompt: 'raw delegated prompt',
      outputFile: '/tmp/raw-task-output.json',
      rawProviderError: 'raw provider error',
      stack: 'Error: stack trace',
      credential: 'secret-token',
      providerTaskHandle: 'provider-task-1',
      unknownProviderField: 'unknown',
    } as Parameters<typeof buildTaskLifecycleRuntimeEvent>[1]);

    expect(event).toMatchObject({
      ...context,
      eventType: 'task.updated',
      payload: {
        taskId: 'task-1',
        toolUseId: 'toolu-1',
        patch: {
          status: 'running',
          description: 'Research',
          endTime: 123,
          totalPausedMs: 0,
          isBackgrounded: true,
          hasError: true,
        },
      },
    });
    expect(JSON.stringify(event)).not.toContain('raw delegated prompt');
    expect(JSON.stringify(event)).not.toContain('/tmp/raw-task-output.json');
    expect(JSON.stringify(event)).not.toContain('raw provider error');
    expect(JSON.stringify(event)).not.toContain('stack trace');
    expect(JSON.stringify(event)).not.toContain('secret-token');
    expect(JSON.stringify(event)).not.toContain('provider-task-1');
    expect(JSON.stringify(event)).not.toContain('unknown');
  });

  it('bounds persisted lifecycle text fields', () => {
    const longText = 'x'.repeat(400);
    const started = buildTaskLifecycleRuntimeEvent(context, {
      kind: 'started',
      taskId: 'task-1',
      description: longText,
    });
    const progress = buildTaskLifecycleRuntimeEvent(context, {
      kind: 'progress',
      taskId: 'task-1',
      lastToolName: longText,
      summary: longText,
    });
    const updated = buildTaskLifecycleRuntimeEvent(context, {
      kind: 'updated',
      taskId: 'task-1',
      patch: {
        status: longText,
        description: longText,
      },
    });

    expect(started?.payload).toMatchObject({
      description: 'x'.repeat(300),
    });
    expect(progress?.payload).toMatchObject({
      lastToolName: 'x'.repeat(300),
      summary: 'x'.repeat(300),
    });
    expect(updated?.payload).toMatchObject({
      patch: {
        status: 'x'.repeat(300),
        description: 'x'.repeat(300),
      },
    });
  });

  it('drops empty task ids so task.notification capability events stay distinct', () => {
    expect(
      buildTaskLifecycleRuntimeEvent(context, {
        kind: 'notification',
        taskId: '   ',
        status: 'blocked',
      }),
    ).toBeNull();
  });
});
