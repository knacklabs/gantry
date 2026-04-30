import type { RuntimeEvent } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';

export interface PublicRunEvent {
  id: string;
  appId: string;
  runId: string;
  type:
    | 'queued'
    | 'started'
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
    payload: event.payload,
    createdAt: event.createdAt,
    metadata: {
      runtimeEventType: event.eventType,
    },
  };
}

function publicRunEventTypeFor(
  eventType: RuntimeEvent['eventType'],
): PublicRunEvent['type'] {
  switch (eventType) {
    case RUNTIME_EVENT_TYPES.RUN_STARTED:
    case RUNTIME_EVENT_TYPES.JOB_STARTED:
    case RUNTIME_EVENT_TYPES.JOB_RUN_STARTED:
      return 'started';
    case RUNTIME_EVENT_TYPES.JOB_STREAMING:
    case RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING:
      return 'output_chunk';
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
      return 'failed';
    default:
      return 'model_event';
  }
}
