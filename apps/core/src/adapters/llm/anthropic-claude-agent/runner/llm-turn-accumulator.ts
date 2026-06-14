import type { AgentRunnerLlmTurn } from './types.js';

/** BetaUsage-shaped subset we read off each assistant message. */
interface BetaUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface SdkAssistantLike {
  message?: {
    /** Anthropic message id. The SDK emits one message as multiple assistant
     * events (e.g. a text block then a tool_use block) sharing this id — they
     * are ONE turn, not several. */
    id?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: BetaUsageLike;
  };
}

function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Accumulates per-turn LLM timing + token usage from the child runner's SDK
 * loop. The SDK emits, per turn, `message_start` (generation begins) → content
 * deltas → an `assistant` message (generation done) → `message_delta` (final
 * usage) → `result`. So a turn's TRUE generation time is `message_start →
 * assistant`: `onTurnStart` stamps the start and `onAssistant` finalizes the
 * duration. Measuring this way (rather than to the next turn / the `result`)
 * excludes the inter-turn gap — i.e. tool-call time, which belongs to the tool
 * stage, not the LLM. If `message_start` was never seen, `closeOpenTurn` falls
 * back to the close boundary so a turn is never reported as 0 ms.
 *
 * `message.usage` is BetaUsage (confirmed present on every SDKAssistantMessage
 * in @anthropic-ai/claude-agent-sdk@0.3.156); it is mapped to the generic
 * `{ in, out, cacheRead, cacheWrite }` shape.
 *
 * Best-effort only — capture must never affect the reply.
 */
export class LlmTurnAccumulator {
  private readonly completed: AgentRunnerLlmTurn[] = [];
  private open: (AgentRunnerLlmTurn & { startedAt: number }) | undefined;
  /** Anthropic message id of the open turn, to merge multi-event messages. */
  private openMessageId: string | undefined;
  /** Wall-clock of the latest `message_start`, consumed by the next turn. */
  private pendingStartedAt: number | undefined;
  private readonly now: () => number;
  private readonly capturePayloads: boolean;

  constructor(opts: { now?: () => number; capturePayloads?: boolean } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.capturePayloads = opts.capturePayloads ?? false;
  }

  /** Called on the `message_start` stream event — marks generation start. */
  onTurnStart(at: number = this.now()): void {
    this.pendingStartedAt = at;
  }

  /**
   * Called on each `assistant` SDK message — the point at which the turn's
   * generation has finished. `arrivalAt` defaults to the current clock; payload
   * `input`/`output` are recorded only when capture is enabled. The turn starts
   * at the last `message_start` (or `arrivalAt` if none was seen) and its `ms`
   * is the generation span, finalized here rather than at the next boundary.
   */
  onAssistant(
    message: SdkAssistantLike,
    arrivalAt: number = this.now(),
    payload?: { input?: unknown; output?: string },
  ): void {
    const messageId = message.message?.id;
    // The SDK emits one Anthropic message as multiple assistant events (e.g. a
    // text block then a tool_use block, same id). Merge them into the open turn
    // rather than opening a phantom duplicate (the tool_use-only event has no
    // text). Extend the generation span to the latest event. Only merge on a
    // real, matching id — id-less events keep one turn each, as before.
    if (
      this.open &&
      messageId !== undefined &&
      this.openMessageId === messageId
    ) {
      if (this.capturePayloads && payload?.output) {
        this.open.output = (this.open.output ?? '') + payload.output;
      }
      if (message.message?.model && !this.open.detail.model) {
        this.open.detail.model = message.message.model;
      }
      this.open.ms = Math.max(this.open.ms, arrivalAt - this.open.startedAt);
      return;
    }
    // A new message closes the previous open turn (its ms is already final).
    if (this.open) this.closeOpenTurn();
    const usage = message.message?.usage ?? {};
    const startedAt = this.pendingStartedAt ?? arrivalAt;
    const turn: AgentRunnerLlmTurn & { startedAt: number } = {
      startedAt,
      ms: Math.max(0, arrivalAt - startedAt),
      detail: {
        ...(message.message?.model ? { model: message.message.model } : {}),
        ...(message.message?.stop_reason
          ? { stopReason: message.message.stop_reason }
          : {}),
        tokens: {
          in: num(usage.input_tokens),
          out: num(usage.output_tokens),
          cacheRead: num(usage.cache_read_input_tokens),
          cacheWrite: num(usage.cache_creation_input_tokens),
        },
      },
    };
    if (this.capturePayloads && payload) {
      if (payload.input !== undefined) turn.input = payload.input;
      if (payload.output !== undefined) turn.output = payload.output;
    }
    this.open = turn;
    this.openMessageId = messageId;
    this.pendingStartedAt = undefined;
  }

  /**
   * Finalize the open turn's token usage from the message's `message_delta`
   * usage — the authoritative final counts (esp. output_tokens). The assistant
   * event only carried a mid-stream snapshot. Best-effort: no-op if no open turn.
   */
  onFinalUsage(
    usage: BetaUsageLike | undefined,
    stopReason?: string | null,
  ): void {
    if (!this.open || !usage) return;
    this.open.detail.tokens = {
      in: num(usage.input_tokens),
      out: num(usage.output_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
    };
    if (stopReason) this.open.detail.stopReason = stopReason;
  }

  /**
   * Finalize the currently-open turn (at a `result` or next-assistant boundary).
   * The duration was already measured at `onAssistant` (generation span); only
   * fall back to `endedAt - startedAt` when no `message_start` was seen (ms still
   * 0) so a turn is never reported as 0 ms.
   */
  closeOpenTurn(endedAt: number = this.now()): void {
    if (!this.open) return;
    if (this.open.ms === 0) {
      this.open.ms = Math.max(0, endedAt - this.open.startedAt);
    }
    this.completed.push(this.open);
    this.open = undefined;
    this.openMessageId = undefined;
  }

  /** All completed turns (call `closeOpenTurn` first to include the last one). */
  turns(): AgentRunnerLlmTurn[] {
    return this.completed;
  }
}
