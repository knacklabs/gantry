import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import type {
  AgentRunnerInput,
  AgentRunnerRuntimeEventOutput,
} from './types.js';

export function runnerStartupTimingRuntimeEvent(input: {
  agentInput: AgentRunnerInput;
  persistSdkSession: boolean;
  resumedSession: boolean;
  sdkQueryPreparedMs: number;
  sdkQueryIteratorMs: number;
  firstSdkEventMs?: number;
  providerSessionMs?: number;
  firstVisibleOutputMs?: number;
  firstResultMs?: number;
  messageCount: number;
  resultCount: number;
  availableToolCount: number;
  allowedToolCount: number;
  disallowedToolCount: number;
  mcpServerCount: number;
}): AgentRunnerRuntimeEventOutput {
  return {
    ...(input.agentInput.appId ? { appId: input.agentInput.appId } : {}),
    ...(input.agentInput.agentId ? { agentId: input.agentInput.agentId } : {}),
    ...(input.agentInput.runId ? { runId: input.agentInput.runId } : {}),
    ...(input.agentInput.jobId ? { jobId: input.agentInput.jobId } : {}),
    conversationId: input.agentInput.chatJid,
    ...(input.agentInput.threadId
      ? { threadId: input.agentInput.threadId }
      : {}),
    eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
    actor: 'runtime',
    responseMode: 'none',
    payload: {
      provider: 'anthropic_sdk',
      diagnostic: 'runner_startup_timing',
      persistSdkSession: input.persistSdkSession,
      resumedSession: input.resumedSession,
      sdkQueryPreparedMs: input.sdkQueryPreparedMs,
      sdkQueryIteratorMs: input.sdkQueryIteratorMs,
      ...(input.firstSdkEventMs !== undefined
        ? { firstSdkEventMs: input.firstSdkEventMs }
        : {}),
      ...(input.providerSessionMs !== undefined
        ? { providerSessionMs: input.providerSessionMs }
        : {}),
      ...(input.firstVisibleOutputMs !== undefined
        ? { firstVisibleOutputMs: input.firstVisibleOutputMs }
        : {}),
      ...(input.firstResultMs !== undefined
        ? { firstResultMs: input.firstResultMs }
        : {}),
      messageCount: input.messageCount,
      resultCount: input.resultCount,
      availableToolCount: input.availableToolCount,
      allowedToolCount: input.allowedToolCount,
      disallowedToolCount: input.disallowedToolCount,
      mcpServerCount: input.mcpServerCount,
    },
  };
}
