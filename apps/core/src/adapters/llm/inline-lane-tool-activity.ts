import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { RunnerOutputFrame } from '../../runner/runner-frame.js';

const TOOL_ACTIVITY_INTERVAL_MS = 15_000;

interface ToolActivityLaneInput {
  input: {
    isScheduledJob?: boolean;
    appId?: string;
    agentId?: string;
    runId?: string;
    jobId?: string;
    chatJid: string;
    threadId?: string;
  };
  emitOutput(output: RunnerOutputFrame): Promise<void>;
}

export interface InlineToolActivity {
  run<T>(toolName: string, operation: () => Promise<T>): Promise<T>;
  start(id: string, toolName: string): Promise<void>;
  finish(
    id: string,
    toolName: string,
    outcome: 'success' | 'failure',
  ): Promise<void>;
  close(): void;
}

export function createInlineToolActivity(
  input: ToolActivityLaneInput,
): InlineToolActivity {
  const timers = new Map<string, NodeJS.Timeout>();
  let sequence = 0;
  const emit = async (
    toolName: string,
    phase: 'started' | 'running' | 'success' | 'failure',
  ) => {
    if (!input.input.isScheduledJob) return;
    await input
      .emitOutput({
        status: 'success',
        result: null,
        runtimeEventOnly: true,
        runtimeEvents: [
          {
            appId: input.input.appId,
            agentId: input.input.agentId,
            runId: input.input.runId,
            jobId: input.input.jobId,
            conversationId: input.input.chatJid,
            threadId: input.input.threadId,
            eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
            actor: 'inline-agent',
            responseMode: 'none',
            payload: {
              phase,
              tool: toolName,
              ...(phase === 'success' ? { ok: true } : {}),
              ...(phase === 'failure' ? { ok: false } : {}),
            },
          },
        ],
      })
      .catch(() => undefined);
  };
  const start = async (id: string, toolName: string) => {
    if (!input.input.isScheduledJob) return;
    await emit(toolName, 'started');
    const timer = setInterval(
      () => void emit(toolName, 'running'),
      TOOL_ACTIVITY_INTERVAL_MS,
    );
    timer.unref?.();
    timers.set(id, timer);
  };
  const finish = async (
    id: string,
    toolName: string,
    outcome: 'success' | 'failure',
  ) => {
    const timer = timers.get(id);
    if (timer) clearInterval(timer);
    timers.delete(id);
    await emit(toolName, outcome);
  };
  return {
    async run<T>(toolName: string, operation: () => Promise<T>): Promise<T> {
      const id = `inline-tool-${sequence++}`;
      await start(id, toolName);
      try {
        const result = await operation();
        await finish(id, toolName, 'success');
        return result;
      } catch (error) {
        await finish(id, toolName, 'failure');
        throw error;
      }
    },
    start,
    finish,
    close() {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
    },
  };
}
