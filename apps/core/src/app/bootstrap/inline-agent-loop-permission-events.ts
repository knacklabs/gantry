import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';

export async function publishInlinePermissionEvent(
  deps: {
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
  },
  request: PermissionApprovalRequest,
  eventType: (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES],
  payload: Record<string, unknown>,
): Promise<void> {
  if (!deps.publishRuntimeEvent || !request.appId) return;
  await deps
    .publishRuntimeEvent({
      appId: request.appId as never,
      agentId: request.agentId as never,
      runId: request.runId as never,
      jobId: request.jobId as never,
      conversationId: request.targetJid as never,
      threadId: request.threadId as never,
      eventType,
      actor: 'permission',
      correlationId: request.requestId,
      payload,
    })
    .catch(() => undefined);
}
