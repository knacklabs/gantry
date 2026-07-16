import type { RuntimeEvent } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import {
  formatDuration,
  formatRunLabel,
  formatRunShortId,
} from '../../shared/human-format.js';

export interface PublicRunEvent {
  id: string;
  appId: string;
  runId: string;
  type:
    | 'queued'
    | 'started'
    | 'diagnostic'
    | 'model_event'
    | 'tool_request'
    | 'permission_decision'
    | 'output_chunk'
    | 'completed'
    | 'failed'
    | 'canceled';
  payload: unknown;
  createdAt: string;
  metadata: {
    runtimeEventType: RuntimeEvent['eventType'];
  };
}

export function projectRuntimeEventToRunEvent(
  event: RuntimeEvent,
  fallbackRunId?: string,
): PublicRunEvent {
  const runId = event.runId ?? fallbackRunId;
  if (!runId) {
    throw new Error(
      `Runtime event ${event.eventId} cannot be projected to a run event without runId`,
    );
  }
  return {
    id: String(event.eventId),
    appId: event.appId,
    runId,
    type: publicRunEventTypeFor(event.eventType),
    payload: enrichRunEventPayload(event.payload, runId, event.createdAt),
    createdAt: event.createdAt,
    metadata: {
      runtimeEventType: event.eventType,
    },
  };
}

function enrichRunEventPayload(
  payload: RuntimeEvent['payload'],
  runId: string,
  eventCreatedAt: string,
): unknown {
  const source =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  const shortId = numberOrString(source.short_id ?? source.shortId);
  const startedAt = stringValue(source.started_at ?? source.startedAt);
  const durationMs = numberValue(source.duration_ms ?? source.durationMs);
  const {
    agent_engine: _agentEngine,
    agentEngine: _camelAgentEngine,
    ...publicSource
  } = source;
  // Read-only run diagnostics: normalize executionProviderId into a stable
  // snake_case shape. Internal agent_engine stays out of projected control API
  // payloads so agentHarness remains the only public agent execution selector.
  const executionProviderId = stringValue(
    source.execution_provider_id ?? source.executionProviderId,
  );
  return {
    ...publicSource,
    runId: stringValue(source.runId) ?? runId,
    short_id: shortId ?? undefined,
    run_short_id: shortId
      ? formatRunShortId({ id: runId, shortId })
      : undefined,
    run_label: formatRunLabel({
      id: runId,
      shortId,
      startedAt: startedAt ?? eventCreatedAt,
    }),
    duration_ms: durationMs ?? undefined,
    duration_text:
      durationMs === undefined ? undefined : formatDuration(durationMs),
    execution_provider_id: executionProviderId ?? undefined,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function numberOrString(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) return value;
  return undefined;
}

function publicRunEventTypeFor(
  eventType: RuntimeEvent['eventType'],
): PublicRunEvent['type'] {
  switch (eventType) {
    case RUNTIME_EVENT_TYPES.RUN_STARTED:
    case RUNTIME_EVENT_TYPES.JOB_STARTED:
    case RUNTIME_EVENT_TYPES.JOB_RUN_STARTED:
      return 'started';
    case RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC:
      return 'diagnostic';
    case RUNTIME_EVENT_TYPES.JOB_STREAMING:
    case RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING:
      return 'output_chunk';
    case RUNTIME_EVENT_TYPES.PERMISSION_REQUESTED:
      return 'tool_request';
    case RUNTIME_EVENT_TYPES.PERMISSION_ALLOWED:
    case RUNTIME_EVENT_TYPES.PERMISSION_DENIED:
    case RUNTIME_EVENT_TYPES.PERMISSION_CANCELLED:
    case RUNTIME_EVENT_TYPES.PERMISSION_PERSISTED:
    case RUNTIME_EVENT_TYPES.PERMISSION_RESUMED:
    case RUNTIME_EVENT_TYPES.PERMISSION_FINAL_OUTCOME:
    case RUNTIME_EVENT_TYPES.PERMISSION_CLASSIFIER_DECISION:
      return 'permission_decision';
    case RUNTIME_EVENT_TYPES.RUN_COMPLETED:
    case RUNTIME_EVENT_TYPES.JOB_COMPLETED:
    case RUNTIME_EVENT_TYPES.JOB_RUN_COMPLETED:
      return 'completed';
    case RUNTIME_EVENT_TYPES.RUN_CANCELED:
      return 'canceled';
    case RUNTIME_EVENT_TYPES.RUN_FAILED:
    case RUNTIME_EVENT_TYPES.RUN_TIMEOUT:
    case RUNTIME_EVENT_TYPES.RUN_DEAD_LETTERED:
    case RUNTIME_EVENT_TYPES.JOB_FAILED:
    case RUNTIME_EVENT_TYPES.JOB_RUN_FAILED:
    case RUNTIME_EVENT_TYPES.SANDBOX_BLOCKED:
      return 'failed';
    default:
      return 'model_event';
  }
}
