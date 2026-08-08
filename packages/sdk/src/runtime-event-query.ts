import type { RuntimeEventQuery } from './types.js';

export function runtimeEventQuery(input: RuntimeEventQuery): string {
  const query = new URLSearchParams();
  if (input.afterStreamPosition !== undefined) {
    query.set('afterStreamPosition', String(input.afterStreamPosition));
  } else if (input.afterEventId !== undefined) {
    query.set('afterEventId', String(input.afterEventId));
  }
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.sessionId) query.set('sessionId', input.sessionId);
  if (input.jobId) query.set('jobId', input.jobId);
  if (input.runId) query.set('runId', input.runId);
  const eventTypes = Array.isArray(input.eventType)
    ? input.eventType
    : input.eventType
      ? [input.eventType]
      : [];
  for (const eventType of eventTypes) query.append('eventType', eventType);
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}
