import type { SessionCommandDeps } from '../session/session-commands.js';
import type { ConversationRoute, NewMessage } from '../domain/types.js';
import type { AgentOutput } from './agent-spawn.js';
import type { GroupAgentRunResult } from './group-agent-runner.js';

type SessionCommandRunAgent = (
  group: ConversationRoute,
  prompt: string,
  chatJid: string,
  queueJid: string,
  onOutput?: (output: AgentOutput) => Promise<void>,
  options?: Record<string, unknown>,
) => Promise<GroupAgentRunResult>;

export function createSessionCommandAgentRunners(input: {
  runAgent: SessionCommandRunAgent;
  group: ConversationRoute;
  chatJid: string;
  queueJid: string;
  memoryUserId?: string;
  activeThreadId?: string | null;
  missedMessages: NewMessage[];
  existingRunId?: string;
  existingRunLeaseToken?: string;
  existingRunLeaseWorkerInstanceId?: string;
  existingRunLeaseFencingVersion?: number;
}): Pick<SessionCommandDeps, 'runAgent' | 'runSessionCompaction'> {
  const commandOptions = (options: Record<string, unknown> = {}) => ({
    ...options,
    memoryContext: {
      source: 'command',
      userId: input.memoryUserId,
      threadId: input.activeThreadId,
    },
    turnMessages: input.missedMessages,
    existingRunId: input.existingRunId,
    existingRunLeaseToken: input.existingRunLeaseToken,
    existingRunLeaseWorkerInstanceId: input.existingRunLeaseWorkerInstanceId,
    existingRunLeaseFencingVersion: input.existingRunLeaseFencingVersion,
  });
  return {
    runAgent: (prompt, onOutput, options) =>
      input.runAgent(
        input.group,
        prompt,
        input.chatJid,
        input.queueJid,
        onOutput,
        commandOptions(options),
      ),
    runSessionCompaction: (onOutput, options) =>
      input.runAgent(
        input.group,
        '',
        input.chatJid,
        input.queueJid,
        onOutput,
        commandOptions({ ...options, maintenanceCompaction: true }),
      ),
  };
}
