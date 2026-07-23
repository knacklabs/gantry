import { SpanStatusCode, type Span } from '@opentelemetry/api';

import {
  boundedContent,
  childContextFor,
  registerDelegationToolSpan,
  registerTurnSpanEndCallback,
  settleDelegationToolSpan,
  tracer,
} from '../../../infrastructure/observability/tracing.js';
import type { SseAccumulatorResult, SseStreamKind } from './sse-accumulator.js';
import {
  boundedToolJson,
  requestToolResults,
  type ToolCall,
} from './genai-message-attributes.js';

interface PendingToolSpan {
  span: Span;
  startedAt: number;
  delegation: boolean;
  unregisterTurnEnd: () => void;
}

export const pendingToolsByRun = new Map<
  string,
  Map<string, PendingToolSpan>
>();

function toolPayload(value: unknown): string {
  return typeof value === 'string'
    ? boundedContent(value)
    : boundedToolJson(value);
}

function toolMetadata(call: ToolCall): {
  transport: 'local' | 'mcp' | 'delegation';
  server?: string;
} {
  const gantryName = call.name.startsWith('mcp__gantry__')
    ? call.name.slice('mcp__gantry__'.length)
    : call.name;
  if (
    gantryName === 'delegate_task' ||
    gantryName === 'AgentDelegation' ||
    gantryName === 'Agent' ||
    gantryName.startsWith('delegate_to_')
  ) {
    return { transport: 'delegation' };
  }
  if (gantryName === 'mcp_call_tool' || gantryName === 'async_mcp_call') {
    const args =
      call.arguments && typeof call.arguments === 'object'
        ? (call.arguments as Record<string, unknown>)
        : undefined;
    return {
      transport: 'mcp',
      ...(call.mcpServer
        ? { server: call.mcpServer }
        : typeof args?.serverName === 'string'
          ? { server: args.serverName }
          : {}),
    };
  }
  const mcp = /^mcp__([A-Za-z0-9_-]+)__/.exec(call.name);
  return mcp ? { transport: 'mcp', server: mcp[1] } : { transport: 'local' };
}

function delegationObjective(call: ToolCall): string | undefined {
  const value = call.arguments ?? call.correlationArguments;
  if (!value || typeof value !== 'object') return undefined;
  const args = value as Record<string, unknown>;
  for (const key of ['objective', 'task', 'prompt']) {
    if (typeof args[key] === 'string' && args[key].trim()) {
      return args[key].trim();
    }
  }
  return undefined;
}

function delegationTaskId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    return /\btask_[A-Za-z0-9][A-Za-z0-9_-]{0,159}\b/.exec(value)?.[0];
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 64)) {
      const found = delegationTaskId(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['taskId', 'id']) {
    const candidate = record[key];
    if (
      typeof candidate === 'string' &&
      /^task_[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(candidate)
    ) {
      return candidate;
    }
  }
  for (const entry of Object.values(record).slice(0, 64)) {
    const found = delegationTaskId(entry, depth + 1);
    if (found) return found;
  }
  return undefined;
}

export function finishPendingToolSpans(
  runId: string,
  kind: SseStreamKind | undefined,
  request: Record<string, unknown>,
  captureContent: boolean,
): void {
  const pending = pendingToolsByRun.get(runId);
  if (!pending) return;
  for (const result of requestToolResults(kind, request)) {
    const active = pending.get(result.id);
    if (!active) continue;
    pending.delete(result.id);
    try {
      active.unregisterTurnEnd();
      if (active.delegation) {
        settleDelegationToolSpan({
          runId,
          callId: result.id,
          taskId:
            result.status === 'error'
              ? undefined
              : delegationTaskId(result.content),
        });
      }
      active.span.setAttribute(
        'gantry.tool.latency_ms',
        Math.max(0, Date.now() - active.startedAt),
      );
      active.span.setAttribute('gantry.tool.status', result.status);
      if (captureContent) {
        active.span.setAttribute(
          'gen_ai.tool.call.result',
          toolPayload(result.content),
        );
      }
      if (result.status === 'error') {
        active.span.setAttribute('error.type', 'tool_error');
        active.span.setStatus({ code: SpanStatusCode.ERROR });
      } else if (result.status === 'success') {
        active.span.setStatus({ code: SpanStatusCode.OK });
      }
    } catch {
      // fail-open
    } finally {
      try {
        active.span.end();
      } catch {
        // fail-open
      }
    }
  }
  if (pending.size === 0) pendingToolsByRun.delete(runId);
}

export function startPendingToolSpans(input: {
  runId: string;
  parent: Span;
  activeTracer: NonNullable<ReturnType<typeof tracer>>;
  toolCalls: ToolCall[];
  captureContent: boolean;
}): void {
  if (input.toolCalls.length === 0) return;
  const pending =
    pendingToolsByRun.get(input.runId) ?? new Map<string, PendingToolSpan>();
  pendingToolsByRun.set(input.runId, pending);
  for (const call of input.toolCalls) {
    if (pending.has(call.id)) continue;
    try {
      const metadata = toolMetadata(call);
      const span = input.activeTracer.startSpan(
        `execute_tool ${call.name.slice(0, 128)}`,
        {
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': call.name,
            'gen_ai.tool.call.id': call.id,
            'gen_ai.tool.type': 'function',
            'gantry.tool.transport': metadata.transport,
            'gantry.tool.timing': 'reconstructed',
            'gantry.run_id': input.runId,
            ...(call.choiceIndex !== undefined
              ? { 'gen_ai.response.choice.index': call.choiceIndex }
              : {}),
            ...(metadata.server
              ? { 'gantry.mcp.server': metadata.server }
              : {}),
            ...(input.captureContent && call.arguments !== undefined
              ? {
                  'gen_ai.tool.call.arguments': toolPayload(call.arguments),
                }
              : {}),
          },
        },
        childContextFor(input.parent),
      );
      if (metadata.transport === 'delegation') {
        registerDelegationToolSpan({
          runId: input.runId,
          callId: call.id,
          objective: delegationObjective(call),
          span,
        });
      }
      pending.set(call.id, {
        unregisterTurnEnd: () => {},
        span,
        startedAt: Date.now(),
        delegation: metadata.transport === 'delegation',
      });
      const active = pending.get(call.id)!;
      active.unregisterTurnEnd = registerTurnSpanEndCallback(
        input.runId,
        () => {
          pending.delete(call.id);
          if (pending.size === 0) pendingToolsByRun.delete(input.runId);
          if (active.delegation) {
            settleDelegationToolSpan({
              runId: input.runId,
              callId: call.id,
            });
          }
          try {
            active.span.setAttribute(
              'gantry.tool.latency_ms',
              Math.max(0, Date.now() - active.startedAt),
            );
            active.span.setAttribute('gantry.tool.status', 'error');
            active.span.setAttribute('error.type', 'tool_result_missing');
            active.span.setStatus({ code: SpanStatusCode.ERROR });
          } catch {
            // fail-open
          } finally {
            try {
              active.span.end();
            } catch {
              // fail-open
            }
          }
        },
      );
    } catch {
      // fail-open
    }
  }
}

export function failPendingToolSpans(
  runId: string,
  callIds: ReadonlySet<string>,
): void {
  const pending = pendingToolsByRun.get(runId);
  if (!pending) return;
  for (const callId of callIds) {
    const active = pending.get(callId);
    if (!active) continue;
    pending.delete(callId);
    active.unregisterTurnEnd();
    if (active.delegation) settleDelegationToolSpan({ runId, callId });
    try {
      active.span.setAttribute(
        'gantry.tool.latency_ms',
        Math.max(0, Date.now() - active.startedAt),
      );
      active.span.setAttribute('gantry.tool.status', 'error');
      active.span.setAttribute('error.type', 'tool_response_failed');
      active.span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // fail-open
    } finally {
      try {
        active.span.end();
      } catch {
        // fail-open
      }
    }
  }
  if (pending.size === 0) pendingToolsByRun.delete(runId);
}

function isCompleteToolCallResponse(
  kind: SseStreamKind | undefined,
  finishReason: string | undefined,
): boolean {
  return (
    (kind === 'anthropic' && finishReason === 'tool_use') ||
    (kind === 'openai' && finishReason === 'tool_calls')
  );
}

export function streamedToolCalls(
  kind: SseStreamKind | undefined,
  streamed: SseAccumulatorResult,
): ToolCall[] {
  return (streamed.toolCalls ?? []).flatMap((call) =>
    typeof call.id === 'string' && typeof call.name === 'string'
      ? [
          {
            ...call,
            id: call.id,
            name: call.name,
            complete:
              call.complete ??
              isCompleteToolCallResponse(kind, streamed.finishReason),
          },
        ]
      : [],
  );
}
