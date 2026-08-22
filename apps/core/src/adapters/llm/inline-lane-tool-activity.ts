import { randomUUID } from 'node:crypto';

import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import {
  privateToolActivityInvocationIdFromResult,
  terminalToolActivityPayload,
} from '../../domain/events/tool-activity.js';
import type { RunnerOutputFrame } from '../../runner/runner-frame.js';
import { CALLABLE_AGENT_TOOL_PREFIX } from '../../shared/callable-agent-manifest.js';
import {
  canonicalGantryToolRuleName,
  gantryOwnedToolActivityFamily,
} from '../../shared/gantry-tool-facades.js';

const TOOL_ACTIVITY_INTERVAL_MS = 15_000;

export const INLINE_PROVIDER_INVOCATION_BINDING_KEY =
  '__gantryProviderInvocationBinding';
export type InlineToolRegistrationProvenance = 'gantry' | 'third-party';

interface ToolActivityLaneInput {
  input: {
    isScheduledJob?: boolean;
    appId?: string;
    agentId?: string;
    runId?: string;
    jobId?: string;
    chatJid: string;
    threadId?: string;
    parentTaskId?: string;
  };
  coreTools: { tools: readonly { name: string }[] };
  emitOutput(output: RunnerOutputFrame): Promise<void>;
}

export interface InlineToolActivity {
  bindProviderInvocation(invocationId: string): string | undefined;
  takeProviderInvocation(bindingToken: string): string | undefined;
  run<T>(
    toolName: string,
    operation: (invocationId: string) => Promise<T>,
    invocationId?: string,
    provenance?: InlineToolRegistrationProvenance,
  ): Promise<T>;
  terminal(
    toolName: string,
    outcome: 'success' | 'failure',
    invocationId?: string,
    provenance?: InlineToolRegistrationProvenance,
  ): Promise<void>;
  hasTerminal(invocationId: string): boolean;
  start(
    id: string,
    toolName: string,
    provenance?: InlineToolRegistrationProvenance,
  ): Promise<void>;
  finish(
    id: string,
    toolName: string,
    outcome: 'success' | 'failure',
    correlationId?: string,
    provenance?: InlineToolRegistrationProvenance,
  ): Promise<void>;
  close(): void;
}

export function createInlineToolActivity(
  input: ToolActivityLaneInput,
): InlineToolActivity {
  const timers = new Map<string, NodeJS.Timeout>();
  const terminalIds = new Set<string>();
  const sequences = new Map<string, number>();
  // Tokens are issued by the trusted provider callback and accepted once. A
  // caller-supplied field cannot resolve to another invocation's provider ID.
  const providerInvocationIds = new Map<string, string>();
  let nextSequence = 0;
  const callableAgentToolNames = new Set(
    input.coreTools.tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith(CALLABLE_AGENT_TOOL_PREFIX)),
  );
  const emit = async (
    invocationId: string,
    toolName: string,
    phase: 'started' | 'running' | 'success' | 'failure',
    seq: number,
    provenance: InlineToolRegistrationProvenance,
  ) => {
    if (input.input.parentTaskId) return;
    const canonicalToolName = canonicalGantryToolRuleName(toolName, {
      callableAgentToolNames,
    });
    const family =
      provenance === 'gantry'
        ? gantryOwnedToolActivityFamily(toolName)
        : undefined;
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
            eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
            actor: 'inline-agent',
            correlationId: invocationId,
            responseMode: 'none',
            payload:
              phase === 'success' || phase === 'failure'
                ? terminalToolActivityPayload({
                    invocationId,
                    tool: canonicalToolName,
                    ...(family ? { family } : {}),
                    outcome: phase,
                    seq,
                  })
                : { phase, tool: canonicalToolName, invocationId, seq },
          },
        ],
      })
      .catch(() => undefined);
  };
  const start = async (
    id: string,
    toolName: string,
    provenance: InlineToolRegistrationProvenance = 'third-party',
  ) => {
    if (terminalIds.has(id)) return;
    const seq = sequences.get(id) ?? ++nextSequence;
    sequences.set(id, seq);
    await emit(id, toolName, 'started', seq, provenance);
    const timer = setInterval(
      () => void emit(id, toolName, 'running', seq, provenance),
      TOOL_ACTIVITY_INTERVAL_MS,
    );
    timer.unref?.();
    timers.set(id, timer);
  };
  const finish = async (
    id: string,
    toolName: string,
    outcome: 'success' | 'failure',
    correlationId = id,
    provenance: InlineToolRegistrationProvenance = 'third-party',
  ) => {
    const timer = timers.get(id);
    if (timer) clearInterval(timer);
    timers.delete(id);
    const alreadyTerminal = terminalIds.has(correlationId);
    terminalIds.add(id);
    if (alreadyTerminal) {
      sequences.delete(id);
      return;
    }
    const seq = sequences.get(id) ?? ++nextSequence;
    terminalIds.add(correlationId);
    await emit(correlationId, toolName, outcome, seq, provenance);
    sequences.delete(id);
  };
  return {
    bindProviderInvocation(invocationId) {
      const id = invocationId.trim();
      if (!id) return undefined;
      const bindingToken = randomUUID();
      providerInvocationIds.set(bindingToken, id);
      return bindingToken;
    },
    takeProviderInvocation(bindingToken) {
      const token = bindingToken.trim();
      if (!token) return undefined;
      const invocationId = providerInvocationIds.get(token);
      providerInvocationIds.delete(token);
      return invocationId;
    },
    async run<T>(
      toolName: string,
      operation: (invocationId: string) => Promise<T>,
      invocationId?: string,
      provenance: InlineToolRegistrationProvenance = 'third-party',
    ): Promise<T> {
      const id = invocationId?.trim() || randomUUID();
      await start(id, toolName, provenance);
      try {
        const result = await operation(id);
        const family =
          provenance === 'gantry'
            ? gantryOwnedToolActivityFamily(toolName)
            : undefined;
        const correlationId = family
          ? (privateToolActivityInvocationIdFromResult(result) ?? id)
          : id;
        await finish(
          id,
          toolName,
          toolResultIsError(result) ? 'failure' : 'success',
          correlationId,
          provenance,
        );
        return result;
      } catch (error) {
        await finish(id, toolName, 'failure', id, provenance);
        throw error;
      }
    },
    async terminal(
      toolName,
      outcome,
      invocationId,
      provenance = 'third-party',
    ) {
      const id = invocationId?.trim() || randomUUID();
      if (terminalIds.has(id)) return;
      const seq = sequences.get(id) ?? ++nextSequence;
      terminalIds.add(id);
      await emit(id, toolName, outcome, seq, provenance);
      sequences.delete(id);
    },
    hasTerminal(invocationId) {
      return terminalIds.has(invocationId);
    },
    start,
    finish,
    close() {
      for (const timer of timers.values()) clearInterval(timer);
      timers.clear();
      terminalIds.clear();
      sequences.clear();
      providerInvocationIds.clear();
    },
  };
}

function toolResultIsError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(toolResultIsError);
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return (
    result.isError === true ||
    result.is_error === true ||
    result.status === 'error' ||
    Boolean(result.error) ||
    toolResultIsError(result.content)
  );
}
