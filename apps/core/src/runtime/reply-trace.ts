/**
 * Generic per-reply latency trace primitives (agent-agnostic).
 *
 * Core mediates the three reply stages — the pre-agent guardrail, the main-LLM
 * turns (captured in the spawned child runner), and each MCP tool call (captured
 * at the core IPC proxy). This module holds the shared record shapes, the
 * in-memory per-run collector that accumulates MCP-call records during a run,
 * and the pure assembly functions that merge the three sources into one
 * timestamp-ordered `timings_json` (always written) and an optional
 * stage-indexed `payloads_json` (flag-gated).
 *
 * Server/tool names live here only as DATA flowing through from the IPC payload
 * — never as string literals — so apps/core stays agent-agnostic.
 */

/** One MCP tool call observed at the core proxy during a run. */
export interface ToolCallRecord {
  server: string;
  tool: string;
  ms: number;
  ok: boolean;
  status?: number;
  /** Wall-clock start (ms epoch) used to order this call against LLM turns. */
  startedAt: number;
  requestBytes: number;
  responseBytes: number;
  /** Full request args — only populated when payload capture is enabled. */
  request?: unknown;
  /** Full response — only populated when payload capture is enabled. */
  response?: unknown;
}

/** One main-LLM assistant turn observed in the child runner's SDK loop. */
export interface LlmTurnRecord {
  ms: number;
  /** Wall-clock start (ms epoch) of the turn (first byte seen). */
  startedAt: number;
  detail: {
    model?: string;
    stopReason?: string;
    tokens?: { in: number; out: number; cacheRead: number; cacheWrite: number };
  };
  /** Full assembled input text — only populated when payload capture is enabled. */
  input?: unknown;
  /** Full output text — only populated when payload capture is enabled. */
  output?: string;
}

/** The pre-agent guardrail decision, timed in core. */
export interface GuardrailRecord {
  ms: number;
  startedAt: number;
  detail: {
    mode: string;
    decision: string;
    reason?: string;
    inlineAttached: boolean;
  };
}

export type LatencyStageKind = 'guardrail' | 'llm' | 'tool' | 'command';

export interface LatencyStage {
  kind: LatencyStageKind;
  label: string;
  ms: number;
  startedAt: number;
  detail: Record<string, unknown>;
}

export interface LatencyTimings {
  version: 1;
  totalMs: number;
  stages: LatencyStage[];
}

export interface AssembleTimingsInput {
  guardrail?: GuardrailRecord;
  llmTurns?: readonly LlmTurnRecord[];
  toolCalls?: readonly ToolCallRecord[];
  command?: { ms: number; startedAt: number; name: string };
}

/** Per-stage payload candidate, used by `assemblePayloads` (flag-gated). */
type StagePayloadSource =
  | { kind: 'tool'; request?: unknown; response?: unknown }
  | { kind: 'llm'; input?: unknown; output?: unknown };

interface BuiltStages {
  stages: LatencyStage[];
  /** Aligned 1:1 with `stages` by index; undefined where no payload applies. */
  payloadSources: (StagePayloadSource | undefined)[];
}

/**
 * Deterministically build the ordered stage list (and the aligned per-stage
 * payload sources) from the three capture sources. Command and guardrail come
 * first by insertion; LLM turns keep their turn-number labels; everything is
 * then sorted by `startedAt` so cross-process (child LLM vs core MCP) ordering
 * reflects real wall-clock interleaving.
 */
function buildStages(input: AssembleTimingsInput): BuiltStages {
  const entries: { stage: LatencyStage; payload?: StagePayloadSource }[] = [];

  if (input.command) {
    entries.push({
      stage: {
        kind: 'command',
        label: input.command.name,
        ms: input.command.ms,
        startedAt: input.command.startedAt,
        detail: { name: input.command.name },
      },
    });
  }
  if (input.guardrail) {
    entries.push({
      stage: {
        kind: 'guardrail',
        label: 'guardrail',
        ms: input.guardrail.ms,
        startedAt: input.guardrail.startedAt,
        detail: input.guardrail.detail,
      },
    });
  }
  (input.llmTurns ?? []).forEach((turn, index) => {
    entries.push({
      stage: {
        kind: 'llm',
        label: `main LLM · turn ${index + 1}`,
        ms: turn.ms,
        startedAt: turn.startedAt,
        detail: turn.detail,
      },
      payload: { kind: 'llm', input: turn.input, output: turn.output },
    });
  });
  (input.toolCalls ?? []).forEach((call) => {
    entries.push({
      stage: {
        kind: 'tool',
        label: call.tool,
        ms: call.ms,
        startedAt: call.startedAt,
        detail: {
          server: call.server,
          tool: call.tool,
          ok: call.ok,
          ...(call.status !== undefined ? { status: call.status } : {}),
          requestBytes: call.requestBytes,
          responseBytes: call.responseBytes,
        },
      },
      payload: { kind: 'tool', request: call.request, response: call.response },
    });
  });

  entries.sort((a, b) => a.stage.startedAt - b.stage.startedAt);

  return {
    stages: entries.map((e) => e.stage),
    payloadSources: entries.map((e) => e.payload),
  };
}

/** Build the always-written `timings_json` (no payloads). */
export function assembleTimings(input: AssembleTimingsInput): LatencyTimings {
  const { stages } = buildStages(input);
  return {
    version: 1,
    totalMs: stages.reduce((sum, stage) => sum + stage.ms, 0),
    stages,
  };
}

/**
 * Build the flag-gated `payloads_json`, keyed by stage index. For `tool` stages
 * this is `{ request, response }`; for `llm` stages `{ input, output }` (the run
 * input prompt is attached to the first turn; each turn carries its own output).
 * Pass the SAME `AssembleTimingsInput` used for `assembleTimings` so indices
 * line up with the persisted `timings_json`.
 */
export function assemblePayloads(
  input: AssembleTimingsInput,
): Record<number, unknown> {
  const { payloadSources } = buildStages(input);
  const payloads: Record<number, unknown> = {};
  payloadSources.forEach((source, index) => {
    if (!source) return;
    if (source.kind === 'tool') {
      payloads[index] = { request: source.request, response: source.response };
    } else {
      payloads[index] = { input: source.input, output: source.output };
    }
  });
  return payloads;
}

export interface TurnTraceSliceInput {
  /** The cumulative LLM-turn list the child emits — grows across a warm run. */
  allTurns: readonly LlmTurnRecord[];
  /** How many of `allTurns` earlier replies in this run already persisted. */
  persistedTurnCount: number;
  /** Outbound message id this reply is keyed to. */
  cursorId: string;
  /** Outbound id of the previous persisted reply (idempotency guard). */
  lastPersistedCursorId?: string;
  /** The pre-agent guardrail decision — belongs to the run's first reply only. */
  guardrail?: GuardrailRecord;
}

export interface TurnTraceSlice {
  llmTurns: LlmTurnRecord[];
  guardrail?: GuardrailRecord;
  /** New high-water mark to carry into the next reply of the same run. */
  nextPersistedTurnCount: number;
}

/**
 * Decide what to persist for the just-finalized reply of a (possibly warm,
 * multi-reply) run. A warm run handles several user turns under one child
 * process and emits the CUMULATIVE turn list each time, so only the tail beyond
 * `persistedTurnCount` belongs to this reply; the guardrail rides the run's
 * first reply alone. Returns `null` when this outbound was already traced
 * (same cursor) or no new turns have accumulated — keeping each outbound message
 * traced exactly once. Pure: the caller owns the cursor + high-water state.
 */
export function selectTurnTraceSlice(
  input: TurnTraceSliceInput,
): TurnTraceSlice | null {
  if (input.cursorId === input.lastPersistedCursorId) return null;
  const llmTurns = input.allTurns.slice(input.persistedTurnCount);
  if (llmTurns.length === 0) return null;
  return {
    llmTurns,
    ...(input.persistedTurnCount === 0 && input.guardrail
      ? { guardrail: input.guardrail }
      : {}),
    nextPersistedTurnCount: input.allTurns.length,
  };
}

/** Opt-in payload-capture flag (boot-hydrated; off by default). */
export const tracePayloadsEnabled = (): boolean =>
  process.env['GANTRY_TRACE_PAYLOADS']?.trim() === '1';

/**
 * In-memory per-run accumulator for MCP-call records. Keyed by the shared run
 * handle (the spawn `processName` / `GANTRY_AGENT_RUN_HANDLE`), which is the one
 * identifier reachable at both the IPC proxy (recordTool) and the persist site
 * (drain). Bounded/FIFO-evicted so a run that never drains cannot leak.
 */
export class RunTraceCollector {
  private map = new Map<string, ToolCallRecord[]>();

  constructor(private readonly opts: { maxRuns?: number } = {}) {}

  recordTool(runId: string, record: ToolCallRecord): void {
    let bucket = this.map.get(runId);
    if (!bucket) {
      const cap = this.opts.maxRuns ?? 200;
      if (this.map.size >= cap) {
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) this.map.delete(oldest);
      }
      bucket = [];
      this.map.set(runId, bucket);
    }
    bucket.push(record);
  }

  /** Return and remove all records for a run (empty array if none). */
  drain(runId: string): ToolCallRecord[] {
    const records = this.map.get(runId) ?? [];
    this.map.delete(runId);
    return records;
  }
}
