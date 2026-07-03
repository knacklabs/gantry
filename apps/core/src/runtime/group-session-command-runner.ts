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

type MemoryUserIdInput =
  | string
  | undefined
  | (() => Promise<string | undefined>);

async function readMemoryUserId(
  value: MemoryUserIdInput,
): Promise<string | undefined> {
  return typeof value === 'function' ? value() : value;
}

export function createSessionCommandAgentRunners(input: {
  runAgent: SessionCommandRunAgent;
  group: ConversationRoute;
  chatJid: string;
  queueJid: string;
  memoryUserId?: MemoryUserIdInput;
  activeThreadId?: string | null;
  missedMessages: NewMessage[];
  existingRunId?: string;
  existingRunLeaseToken?: string;
  existingRunLeaseWorkerInstanceId?: string;
  existingRunLeaseFencingVersion?: number;
}): Pick<SessionCommandDeps, 'runAgent' | 'runSessionCompaction'> {
  const commandOptions = async (options: Record<string, unknown> = {}) => {
    const memoryUserId = await readMemoryUserId(input.memoryUserId);
    return {
      ...options,
      memoryContext: {
        source: 'command',
        userId: memoryUserId,
        threadId: input.activeThreadId,
      },
      turnMessages: input.missedMessages,
      existingRunId: input.existingRunId,
      existingRunLeaseToken: input.existingRunLeaseToken,
      existingRunLeaseWorkerInstanceId: input.existingRunLeaseWorkerInstanceId,
      existingRunLeaseFencingVersion: input.existingRunLeaseFencingVersion,
    };
  };
  return {
    runAgent: async (prompt, onOutput, options) =>
      input.runAgent(
        input.group,
        prompt,
        input.chatJid,
        input.queueJid,
        onOutput,
        await commandOptions(options),
      ),
    runSessionCompaction: async (onOutput, options) =>
      input.runAgent(
        input.group,
        '',
        input.chatJid,
        input.queueJid,
        onOutput,
        await commandOptions({ ...options, maintenanceCompaction: true }),
      ),
  };
}
