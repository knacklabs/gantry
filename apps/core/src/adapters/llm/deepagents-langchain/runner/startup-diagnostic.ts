import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import type { CachePromptControlMode } from './cache-control.js';
import type { DeepAgentCheckpointTimingSnapshot } from './session-store.js';
import type { DeepAgentRunnerInput } from './types.js';

export type DeepAgentStartupPhase =
  | 'modelBuildMs'
  | 'systemPromptMs'
  | 'permissionEnvMs'
  | 'mcpConnectMs'
  | 'graphCreateMs'
  | 'turnMessagesMs'
  | 'streamIteratorMs'
  | 'streamNormalizeMs';

export interface DeepAgentStartupTimingSnapshot {
  totalMs: number;
  phases: Partial<Record<DeepAgentStartupPhase, number>>;
  toolsReadyMs?: number;
  firstLangGraphEventMs?: number;
  firstLangGraphEventName?: string;
  firstVisibleOutputMs?: number;
  firstToolStartMs?: number;
  toolStartCount: number;
}

export function createDeepAgentStartupTiming(input: { nowMs: () => number }): {
  measure: <T>(phase: DeepAgentStartupPhase, work: () => T) => T;
  measureAsync: <T>(
    phase: DeepAgentStartupPhase,
    work: () => Promise<T>,
  ) => Promise<T>;
  markFirstLangGraphEvent: (eventName: string) => void;
  markFirstVisibleOutput: () => void;
  markToolsReady: () => void;
  markToolStart: () => void;
  snapshot: () => DeepAgentStartupTimingSnapshot;
} {
  const startedAt = input.nowMs();
  const phases: Partial<Record<DeepAgentStartupPhase, number>> = {};
  let toolsReadyMs: number | undefined;
  let firstLangGraphEventMs: number | undefined;
  let firstLangGraphEventName: string | undefined;
  let firstVisibleOutputMs: number | undefined;
  let firstToolStartMs: number | undefined;
  let toolStartCount = 0;

  const elapsedSince = (since: number) =>
    Math.max(0, Math.round(input.nowMs() - since));
  const elapsedFromStart = () => elapsedSince(startedAt);

  return {
    measure<T>(phase: DeepAgentStartupPhase, work: () => T): T {
      const phaseStartedAt = input.nowMs();
      try {
        return work();
      } finally {
        phases[phase] = elapsedSince(phaseStartedAt);
      }
    },
    async measureAsync<T>(
      phase: DeepAgentStartupPhase,
      work: () => Promise<T>,
    ): Promise<T> {
      const phaseStartedAt = input.nowMs();
      try {
        return await work();
      } finally {
        phases[phase] = elapsedSince(phaseStartedAt);
      }
    },
    markFirstLangGraphEvent(eventName: string): void {
      if (firstLangGraphEventMs !== undefined) return;
      firstLangGraphEventMs = elapsedFromStart();
      firstLangGraphEventName = eventName;
    },
    markFirstVisibleOutput(): void {
      if (firstVisibleOutputMs !== undefined) return;
      firstVisibleOutputMs = elapsedFromStart();
    },
    markToolsReady(): void {
      if (toolsReadyMs !== undefined) return;
      toolsReadyMs = elapsedFromStart();
    },
    markToolStart(): void {
      toolStartCount += 1;
      if (firstToolStartMs !== undefined) return;
      firstToolStartMs = elapsedFromStart();
    },
    snapshot(): DeepAgentStartupTimingSnapshot {
      return {
        totalMs: elapsedFromStart(),
        phases: { ...phases },
        ...(toolsReadyMs !== undefined ? { toolsReadyMs } : {}),
        ...(firstLangGraphEventMs !== undefined
          ? { firstLangGraphEventMs }
          : {}),
        ...(firstLangGraphEventName ? { firstLangGraphEventName } : {}),
        ...(firstVisibleOutputMs !== undefined ? { firstVisibleOutputMs } : {}),
        ...(firstToolStartMs !== undefined ? { firstToolStartMs } : {}),
        toolStartCount,
      };
    },
  };
}

export function buildDeepAgentStartupDiagnosticEvent(input: {
  agentInput: DeepAgentRunnerInput;
  modelProvider: string;
  modelId: string;
  endpointFamily: 'openai' | 'openrouter';
  timing: DeepAgentStartupTimingSnapshot;
  selectedAllowedToolCount: number;
  connectedToolCount: number;
  systemPromptChars: number;
  memoryContextChars: number;
  turnMessageCount: number;
  cacheMode: CachePromptControlMode;
  checkpointerConfigured: boolean;
  deepAgentSkillSourceCount?: number;
  deepAgentSkillFileCount?: number;
  deepAgentSkillContentBytes?: number;
  deepAgentSkillReadToolsEnabled?: boolean;
  checkpointTiming?: DeepAgentCheckpointTimingSnapshot;
  scheduledJob: boolean;
}): NonNullable<RunnerOutputFrame['runtimeEvents']>[number] {
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
      provider: 'deepagents',
      diagnostic: 'runner_startup',
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      endpointFamily: input.endpointFamily,
      selectedAllowedToolCount: input.selectedAllowedToolCount,
      connectedToolCount: input.connectedToolCount,
      systemPromptChars: input.systemPromptChars,
      memoryContextChars: input.memoryContextChars,
      turnMessageCount: input.turnMessageCount,
      cacheMode: input.cacheMode,
      checkpointerConfigured: input.checkpointerConfigured,
      deepAgentSkillSourceCount: input.deepAgentSkillSourceCount ?? 0,
      deepAgentSkillFileCount: input.deepAgentSkillFileCount ?? 0,
      deepAgentSkillContentBytes: input.deepAgentSkillContentBytes ?? 0,
      deepAgentSkillReadToolsEnabled:
        input.deepAgentSkillReadToolsEnabled === true,
      ...(input.checkpointTiming
        ? {
            checkpointLoadCount: input.checkpointTiming.loadCount,
            checkpointLoadMs: input.checkpointTiming.loadMs,
            ...(input.checkpointTiming.maxLoadMs !== undefined
              ? { checkpointMaxLoadMs: input.checkpointTiming.maxLoadMs }
              : {}),
            checkpointWriteCount: input.checkpointTiming.writeCount,
            checkpointWriteMs: input.checkpointTiming.writeMs,
            ...(input.checkpointTiming.maxWriteMs !== undefined
              ? { checkpointMaxWriteMs: input.checkpointTiming.maxWriteMs }
              : {}),
          }
        : {}),
      scheduledJob: input.scheduledJob,
      totalMs: input.timing.totalMs,
      phases: input.timing.phases,
      ...(input.timing.toolsReadyMs !== undefined
        ? { toolsReadyMs: input.timing.toolsReadyMs }
        : {}),
      ...(input.timing.firstLangGraphEventMs !== undefined
        ? { firstLangGraphEventMs: input.timing.firstLangGraphEventMs }
        : {}),
      ...(input.timing.firstLangGraphEventName
        ? { firstLangGraphEventName: input.timing.firstLangGraphEventName }
        : {}),
      ...(input.timing.firstVisibleOutputMs !== undefined
        ? { firstVisibleOutputMs: input.timing.firstVisibleOutputMs }
        : {}),
      ...(input.timing.firstToolStartMs !== undefined
        ? { firstToolStartMs: input.timing.firstToolStartMs }
        : {}),
      toolStartCount: input.timing.toolStartCount,
    },
  };
}
