import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { ConversationId, ConversationThreadId, UserId } from '../../domain/conversation/conversation.js';
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
export declare function resolveAgentSessionKey(input: AgentSessionKeyInput): string;
export declare function deterministicAgentSessionId(input: AgentSessionKeyInput): AgentSessionId;
