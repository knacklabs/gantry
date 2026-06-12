import { describe, expect, it } from 'vitest';

import { projectRuntimeEventToRunEvent } from '@core/control/server/run-event-projection.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import type { RuntimeEvent } from '@core/domain/events/events.js';

function event(eventType: RuntimeEvent['eventType']): RuntimeEvent {
  return {
    eventId: 1 as never,
    appId: 'app:test' as never,
    runId: 'run:test' as never,
    eventType,
    actor: 'test',
    payload: {},
    createdAt: '2026-05-13T00:00:00.000Z' as never,
  };
}

describe('run event projection', () => {
  it('projects permission and sandbox events to public run event types', () => {
    expect(
      projectRuntimeEventToRunEvent(
        event(RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED),
      ).type,
    ).toBe('tool_request');
    expect(
      projectRuntimeEventToRunEvent(
        event(RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED),
      ).type,
    ).toBe('permission_decision');
    expect(
      projectRuntimeEventToRunEvent(event(RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED))
        .type,
    ).toBe('failed');
  });

  it('adds human-readable run fields to payloads', () => {
    const projected = projectRuntimeEventToRunEvent({
      ...event(RUNTIME_EVENT_TYPES.JOB_RUN_STARTED),
      runId: '550e8400-e29b-41d4-a716' as never,
      payload: {
        short_id: 4,
        duration_ms: 132_000,
      },
    });

    expect(projected.payload).toMatchObject({
      runId: '550e8400-e29b-41d4-a716',
      short_id: 4,
      run_short_id: '#4',
      run_label: expect.stringContaining('Run #4'),
      duration_ms: 132_000,
      duration_text: '2m 12s',
    });
  });

  it('A8: surfaces agent_engine and execution_provider_id diagnostics from JOB_STARTED', () => {
    const projected = projectRuntimeEventToRunEvent({
      ...event(RUNTIME_EVENT_TYPES.JOB_STARTED),
      payload: {
        agent_engine: 'deepagents',
        execution_provider_id: 'deepagents:langchain',
      },
    });

    expect(projected.payload).toMatchObject({
      agent_engine: 'deepagents',
      execution_provider_id: 'deepagents:langchain',
    });
  });

  it('A8: normalizes camelCase engine diagnostics into the snake_case view shape', () => {
    const projected = projectRuntimeEventToRunEvent({
      ...event(RUNTIME_EVENT_TYPES.JOB_STARTED),
      payload: {
        agentEngine: 'deepagents',
        executionProviderId: 'deepagents:langchain',
      },
    });

    expect(projected.payload).toMatchObject({
      agent_engine: 'deepagents',
      execution_provider_id: 'deepagents:langchain',
    });
  });
});
