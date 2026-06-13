import { logger } from '../infrastructure/logging/logger.js';
import {
  assemblePayloads,
  assembleTimings,
  type GuardrailRecord,
  type LlmTurnRecord,
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
  command?: { name: string; ms: number; startedAt: number };
  systemPrompt?: { hash: string; chars: number };
  now?: () => Date;
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
    const toolCalls = input.runHandle
      ? input.replyTrace.drain(input.runHandle)
      : [];
    const assembleInput = {
      ...(input.guardrail ? { guardrail: input.guardrail } : {}),
      ...(input.llmTurns ? { llmTurns: input.llmTurns } : {}),
      ...(input.command ? { command: input.command } : {}),
      toolCalls,
    };
    const timings = assembleTimings(assembleInput);
    if (timings.stages.length === 0) return;

    const payloadsJson = input.replyTrace.payloadsEnabled()
      ? assemblePayloads(
          assembleInput,
          input.systemPrompt ? { systemPrompt: input.systemPrompt } : {},
        )
      : null;

    const createdAt = (input.now ? input.now() : new Date()).toISOString();
    await input.replyTrace.saveTrace({
      messageId: messageIdFor(input.chatJid, input.outboundMessageId),
      appId: input.appId,
      conversationId: input.chatJid,
      kind: input.kind,
      totalMs: timings.totalMs,
      timingsJson: timings,
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
