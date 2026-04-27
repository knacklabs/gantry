import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../../domain/conversation/conversation.js';
import type { JobId } from '../../domain/jobs/jobs.js';
import type { AgentSessionId } from '../../domain/sessions/sessions.js';

export interface AgentSessionKeyInput {
  appId: AppId;
  agentId: AgentId;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  userId?: UserId;
  jobId?: JobId;
}

export function resolveAgentSessionKey(input: AgentSessionKeyInput): string {
  return [
    `app=${input.appId}`,
    `agent=${input.agentId}`,
    `conversation=${input.conversationId ?? ''}`,
    `thread=${input.threadId ?? ''}`,
    `user=${input.userId ?? ''}`,
    `job=${input.jobId ?? ''}`,
  ].join('|');
}

export function deterministicAgentSessionId(
  input: AgentSessionKeyInput,
): AgentSessionId {
  return `agent-session-key:${stableEncode(resolveAgentSessionKey(input))}` as AgentSessionId;
}

function stableEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}
