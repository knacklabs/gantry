import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type {
  PermissionApprovalRequest,
  UserQuestionRequest,
} from '../domain/types.js';
import type { IpcDeps } from './ipc-domain-types.js';

export async function publishPermissionRuntimeEvent(
  deps: IpcDeps,
  request: PermissionApprovalRequest,
  input: {
    eventType: (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES];
    payload: Record<string, unknown>;
  },
): Promise<void> {
  if (!deps.publishRuntimeEvent || !request.appId) return;
  try {
    await deps.publishRuntimeEvent({
      appId: request.appId as never,
      agentId: request.agentId as never,
      runId: request.runId as never,
      jobId: request.jobId as never,
      conversationId: request.targetJid as never,
      threadId: request.threadId as never,
      eventType: input.eventType,
      actor: 'permission',
      correlationId: request.requestId,
      payload: input.payload,
    });
  } catch {
    // Runtime-event telemetry is best-effort; permission IPC response delivery
    // must not fail because event persistence is temporarily unavailable.
  }
}

export async function publishPendingInteractionRuntimeEvent(
  deps: IpcDeps,
  request: PermissionApprovalRequest | UserQuestionRequest,
  kind: 'permission' | 'question',
  sourceAgentFolder: string,
): Promise<void> {
  if (!deps.publishRuntimeEvent) return;
  try {
    await deps.publishRuntimeEvent({
      appId: (request.appId ?? 'default') as never,
      agentId: request.agentId as never,
      runId: request.runId as never,
      jobId: request.jobId as never,
      conversationId: request.targetJid as never,
      threadId: request.threadId as never,
      eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
      actor: 'interaction',
      correlationId: request.requestId,
      payload: {
        kind,
        requestId: request.requestId,
        sourceAgentFolder,
        status: 'pending',
      },
    });
  } catch {
    // Durable interaction recording succeeded; wakeup telemetry is best-effort.
  }
}
