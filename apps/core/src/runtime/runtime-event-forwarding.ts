import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import {
  isRuntimeEventConversationFkId,
  isRuntimeEventThreadFkId,
} from '../domain/events/runtime-event-conversation.js';
import {
  isRuntimeEventType,
  RUNTIME_EVENT_TYPES,
} from '../domain/events/runtime-event-types.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { AgentOutput } from './agent-spawn.js';

export { RUNTIME_EVENT_TYPES };

function runtimeEventDedupKey(input: {
  eventType: string;
  appId?: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
  conversationId?: string;
  threadId?: string | null;
  payload?: unknown;
}): string {
  let payload: string;
  try {
    payload = JSON.stringify(input.payload) ?? 'undefined';
  } catch {
    payload = String(input.payload);
  }
  return [
    input.eventType,
    input.appId ?? '',
    input.agentId ?? '',
    input.runId ?? '',
    input.jobId ?? '',
    input.conversationId ?? '',
    input.threadId ?? '',
    payload,
  ].join('\u001f');
}

function payloadWithRouteContext(input: {
  payload: unknown;
  conversationJid?: string;
  threadId?: string | null;
}): unknown {
  if (
    input.payload === null ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    return input.payload;
  }
  const payload = input.payload as Record<string, unknown>;
  return {
    ...payload,
    ...(!('conversationJid' in payload) && input.conversationJid
      ? { conversationJid: input.conversationJid }
      : {}),
    ...(!('threadId' in payload) && input.threadId
      ? { threadId: input.threadId }
      : {}),
  };
}

export async function forwardRuntimeEvents(input: {
  output: AgentOutput;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<void> | void;
  runtimeAppId: string;
  turnAgentId?: string;
  runId?: string;
  chatJid: string;
  sessionThreadId: string | null;
  forwardedKeys: Set<string>;
}): Promise<void> {
  const { output, publishRuntimeEvent } = input;
  if (!output.runtimeEvents?.length || !publishRuntimeEvent) return;
  for (const event of output.runtimeEvents) {
    if (!isRuntimeEventType(event.eventType)) continue;
    const appId = event.appId ?? input.runtimeAppId;
    if (!appId) continue;
    const eventKey = runtimeEventDedupKey({
      eventType: event.eventType,
      appId,
      agentId: event.agentId ?? input.turnAgentId,
      runId: event.runId ?? input.runId,
      jobId: event.jobId,
      conversationId: event.conversationId ?? input.chatJid,
      threadId: event.threadId ?? input.sessionThreadId,
      payload: event.payload,
    });
    if (input.forwardedKeys.has(eventKey)) continue;
    try {
      await publishRuntimeEvent({
        appId: appId as never,
        ...((event.agentId ?? input.turnAgentId)
          ? { agentId: (event.agentId ?? input.turnAgentId) as never }
          : {}),
        ...((event.runId ?? input.runId)
          ? { runId: (event.runId ?? input.runId) as never }
          : {}),
        ...(event.jobId ? { jobId: event.jobId as never } : {}),
        conversationId: (event.conversationId ?? input.chatJid) as never,
        ...((event.threadId ?? input.sessionThreadId)
          ? { threadId: (event.threadId ?? input.sessionThreadId) as never }
          : {}),
        eventType: event.eventType,
        actor: event.actor ?? 'runner',
        responseMode: event.responseMode ?? 'none',
        payload: event.payload,
      });
      // Mark forwarded only after a successful publish so a failed event
      // remains retriable on a later forwarding pass in the same turn.
      input.forwardedKeys.add(eventKey);
    } catch (error) {
      // Runtime events are observability/audit breadcrumbs. They must not
      // fail a user-visible turn when storage is temporarily unhealthy or
      // schema drift is being repaired. The key is intentionally NOT added,
      // so a later forwarding pass can retry this event.
      logger.warn(
        {
          error,
          eventType: event.eventType,
          conversationId: event.conversationId ?? input.chatJid,
          runId: event.runId ?? input.runId,
          agentId: event.agentId ?? input.turnAgentId,
        },
        'Failed to persist forwarded runtime event; will remain retriable',
      );
    }
  }
}
