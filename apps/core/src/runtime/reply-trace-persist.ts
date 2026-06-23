import { logger } from '../infrastructure/logging/logger.js';
import {
  assembleTimeline,
  assembleTimelinePayloads,
  type GuardrailRecord,
  type LlmTurnRecord,
  type OperationalTimelineSectionInput,
  type ToolCallRecord,
} from './reply-trace.js';
import type { ReplyTracePort } from './group-processing-types.js';
import type { MessageTraceKind } from '../adapters/storage/postgres/repositories/message-trace-repository.postgres.js';

/**
 * Canonical message id (the `messages.id` primary key, and the FK target for
 * `message_traces.message_id`). Mirrors `messageIdFor` in
 * canonical-message-repository.postgres.ts — kept in sync by format, not import.
 */
function messageIdFor(chatJid: string, id: string): string {
  return `message:${chatJid}:${id}`;
}

export interface PersistReplyTraceInput {
  replyTrace: ReplyTracePort;
  kind: MessageTraceKind;
  chatJid: string;
  appId: string;
  /** Raw outbound message id (e.g. `outbound:...`); becomes the canonical FK. */
  outboundMessageId: string;
  /** The run handle whose MCP-call records to drain (best-effort). */
  runHandle?: string;
  guardrail?: GuardrailRecord;
  llmTurns?: readonly LlmTurnRecord[];
  llmUsage?: { costUsd?: number };
  toolCalls?: readonly ToolCallRecord[];
  operationalSections?: readonly OperationalTimelineSectionInput[];
  command?: { name: string; ms: number; startedAt: number };
  windowStart?: number;
  windowEnd?: number;
  send?: { startedAt: number; endedAt: number };
  startup?: { startedAt: number; readyAt: number };
  /** Warm continuation: when this turn's generation was dispatched (ms epoch). */
  dispatchedAt?: number;
  now?: () => Date;
}

function spanEnd(call: ToolCallRecord): number {
  return call.startedAt + call.ms;
}

function overlaps(a: ToolCallRecord, b: ToolCallRecord): boolean {
  return a.startedAt < spanEnd(b) && b.startedAt < spanEnd(a);
}

function mergeToolCalls(
  coreCalls: readonly ToolCallRecord[],
  runnerCalls: readonly ToolCallRecord[] | undefined,
): ToolCallRecord[] {
  if (!runnerCalls || runnerCalls.length === 0) return [...coreCalls];
  const merged = [...coreCalls];
  for (const runnerCall of runnerCalls) {
    if (coreCalls.some((coreCall) => overlaps(coreCall, runnerCall))) {
      continue;
    }
    merged.push(runnerCall);
  }
  return merged;
}

/**
 * Assemble and persist one per-reply (or per-command) latency trace, keyed by
 * the outbound message id. BEST-EFFORT: this runs AFTER the customer reply has
 * already been sent, so every failure (drain, assembly, save) is swallowed and
 * logged — it must never block, delay, or fail the reply. Skips persistence
 * entirely when there are no stages to record.
 */
export async function persistReplyTrace(
  input: PersistReplyTraceInput,
): Promise<void> {
  try {
    const coreToolCalls = input.runHandle
      ? input.replyTrace.drain(input.runHandle)
      : [];
    const toolCalls = mergeToolCalls(coreToolCalls, input.toolCalls);
    const assembleInput = {
      ...(input.windowStart !== undefined
        ? { windowStart: input.windowStart }
        : {}),
      ...(input.windowEnd !== undefined ? { windowEnd: input.windowEnd } : {}),
      ...(input.guardrail ? { guardrail: input.guardrail } : {}),
      ...(input.startup ? { startup: input.startup } : {}),
      ...(input.llmTurns ? { llmTurns: input.llmTurns } : {}),
      ...(input.llmUsage ? { llmUsage: input.llmUsage } : {}),
      ...(input.operationalSections
        ? { operationalSections: input.operationalSections }
        : {}),
      ...(input.send ? { send: input.send } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.dispatchedAt !== undefined
        ? { dispatchedAt: input.dispatchedAt }
        : {}),
      toolCalls,
    };
    const timeline = assembleTimeline(assembleInput);
    if (timeline.sections.length === 0) return;

    const payloadsJson = input.replyTrace.payloadsEnabled()
      ? assembleTimelinePayloads(assembleInput)
      : null;

    const createdAt = (input.now ? input.now() : new Date()).toISOString();
    await input.replyTrace.saveTrace({
      messageId: messageIdFor(input.chatJid, input.outboundMessageId),
      appId: input.appId,
      conversationId: input.chatJid,
      kind: input.kind,
      totalMs: timeline.totalMs,
      timingsJson: timeline,
      payloadsJson,
      createdAt,
    });
  } catch (err) {
    // The reply is already out the door — a trace failure is non-fatal.
    logger.warn(
      { err, chatJid: input.chatJid, kind: input.kind },
      'Failed to assemble/persist reply trace (best-effort, ignored)',
    );
  }
}
