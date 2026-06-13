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
 * loop. Each `assistant` message opens a turn (stamping its wall-clock start)
 * and closes the previous one; `closeOpenTurn` finalizes the last turn at the
 * `result` boundary. `message.usage` is BetaUsage (confirmed present on every
 * SDKAssistantMessage in @anthropic-ai/claude-agent-sdk@0.3.156); it is mapped
 * to the generic `{ in, out, cacheRead, cacheWrite }` shape.
 *
 * Best-effort only — capture must never affect the reply.
 */
export class LlmTurnAccumulator {
  private readonly completed: AgentRunnerLlmTurn[] = [];
  private open:
    | (AgentRunnerLlmTurn & { startedAt: number })
    | undefined;
  private readonly now: () => number;
  private readonly capturePayloads: boolean;

  constructor(opts: { now?: () => number; capturePayloads?: boolean } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.capturePayloads = opts.capturePayloads ?? false;
  }

  /**
   * Called on each `assistant` SDK message. `startedAt` defaults to the current
   * clock; payload `input`/`output` are recorded only when capture is enabled.
   */
  onAssistant(
    message: SdkAssistantLike,
    startedAt: number = this.now(),
    payload?: { input?: unknown; output?: string },
  ): void {
    // A new assistant message closes the previous open turn at this boundary.
    if (this.open) this.closeOpenTurn(startedAt);
    const usage = message.message?.usage ?? {};
    const turn: AgentRunnerLlmTurn & { startedAt: number } = {
      startedAt,
      ms: 0,
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
  }

  /** Finalize the currently-open turn (at a `result` or next-assistant boundary). */
  closeOpenTurn(endedAt: number = this.now()): void {
    if (!this.open) return;
    this.open.ms = Math.max(0, endedAt - this.open.startedAt);
    this.completed.push(this.open);
    this.open = undefined;
  }

  /** All completed turns (call `closeOpenTurn` first to include the last one). */
  turns(): AgentRunnerLlmTurn[] {
    return this.completed;
  }
}
