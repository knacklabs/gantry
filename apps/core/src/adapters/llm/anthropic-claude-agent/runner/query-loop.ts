import type {
  EffortLevel,
  ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import {
  closeQueryLoop,
  createQueryLoopContext,
  finishQueryLoop,
  prepareSdkQuery,
} from './query-loop-phases-setup.js';
import {
  beginQueryLoopMessage,
  handleAssistantMessage,
  handleResultMessage,
  handleStreamEvent,
  handleSystemMessage,
} from './query-loop-phases-messages.js';
import type {
  AgentRunnerInput,
  AgentRunnerToolAttemptOutput,
} from './types.js';

export { recordSuccessfulToolUse } from './query-tool-success-ledger.js';

interface RunQueryOptions {
  enableIpcFollowups?: boolean;
  persistSdkSession?: boolean;
}

export async function runQuery(
  prompt: string,
  mcpServerPath: string,
  agentInput: AgentRunnerInput,
  sdkEnv: Record<string, string | undefined>,
  configuredModel: string | undefined,
  queryThinking: ThinkingConfig | undefined,
  queryEffort: EffortLevel | undefined,
  options: RunQueryOptions = {},
): Promise<{
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  primeToolAttempts: AgentRunnerToolAttemptOutput[];
}> {
  const context = createQueryLoopContext({
    prompt,
    mcpServerPath,
    agentInput,
    sdkEnv,
    configuredModel,
    queryThinking,
    queryEffort,
    enableIpcFollowups: options.enableIpcFollowups ?? true,
    persistSdkSession: options.persistSdkSession ?? true,
  });
  const sdkQuery = prepareSdkQuery(context);
  try {
    for await (const message of sdkQuery) {
      beginQueryLoopMessage(context, message);
      if (message.type === 'assistant') {
        handleAssistantMessage(context, message);
      }
      if (message.type === 'system') {
        handleSystemMessage(context, message);
      }
      if (message.type === 'stream_event') {
        handleStreamEvent(context, message);
      }
      if (message.type === 'result') {
        await handleResultMessage(context, message);
      }
    }
  } finally {
    closeQueryLoop(context);
  }
  return finishQueryLoop(context);
}
