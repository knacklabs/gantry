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

export interface ToolTracePayload {
  request?: unknown;
  response?: unknown;
}

export interface LlmTracePayload {
  input?: unknown;
  output?: unknown;
}

export interface CacheTracePayload {
  provider: string;
  modelAlias?: string;
  promptShapeKey: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  input?: unknown;
  output?: unknown;
  capturedAt?: string;
}

export interface CacheTracePayloadEnvelope {
  cache: CacheTracePayload;
}

/**
 * Stage-indexed debug payload written to `payloads_json` only when payload
 * tracing is enabled. The map key is the timeline/timings section index.
 */
export type TracePayloadEnvelope =
  | ToolTracePayload
  | LlmTracePayload
  | CacheTracePayloadEnvelope;

export type TracePayloadsByStage = Record<number, TracePayloadEnvelope>;

/** Per-stage payload candidate, used by payload assemblers (flag-gated). */
type StagePayloadSource = TracePayloadEnvelope;

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
      payload: { input: turn.input, output: turn.output },
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
      payload: { request: call.request, response: call.response },
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
): TracePayloadsByStage {
  const { payloadSources } = buildStages(input);
  const payloads: TracePayloadsByStage = {};
  payloadSources.forEach((source, index) => {
    if (!source) return;
    payloads[index] = source;
  });
  return payloads;
}

export type OperationalTimelineSectionKind =
  | 'webhook_ack'
  | 'message_persist'
  | 'dedupe'
  | 'notify_publish'
  | 'notify_receive'
  | 'lease_claim'
  | 'lease_heartbeat'
  | 'lease_takeover'
  | 'outbound_fence'
  | 'outbound_recovery'
  | 'cache_prewarm'
  | 'cache_use';

export type TimelineSectionKind =
  | 'queue'
  | 'guardrail'
  | 'startup'
  | 'llm'
  | 'tool'
  | 'send'
  | 'command'
  | 'gap'
  | OperationalTimelineSectionKind;

export interface TimelineSection {
  kind: TimelineSectionKind;
  /** Generic short label; the admin maps kind -> display string. */
  label: string;
  ms: number;
  startedAt: number;
  detail: Record<string, unknown>;
}

export interface LatencyTimeline {
  version: 2;
  windowStart: number;
  windowEnd: number;
  /** windowEnd - windowStart; the sections sum to exactly this. */
  totalMs: number;
  /** Exact reply-level LLM usage reported by the SDK, when available. */
  llmUsage?: {
    costUsd?: number;
  };
  sections: TimelineSection[];
}

export interface AssembleTimelineInput {
  /** Driving inbound's ingress instant (ms epoch). */
  windowStart?: number;
  /** Outbound send-completed instant (ms epoch). */
  windowEnd?: number;
  guardrail?: GuardrailRecord;
  /** Agent-process startup: run-invoke -> first SDK message ready. */
  startup?: { startedAt: number; readyAt: number };
  llmTurns?: readonly LlmTurnRecord[];
  /** Exact reply-level LLM usage reported by the SDK, when available. */
  llmUsage?: {
    costUsd?: number;
  };
  toolCalls?: readonly ToolCallRecord[];
  /**
   * Runtime pipeline spans that are not LLM/tool/guardrail stages. These are
   * observability-only and must be supplied by the caller after the hot-path
   * work is already complete.
   */
  operationalSections?: readonly OperationalTimelineSectionInput[];
  /** Outbound send bracket (ms epoch). */
  send?: { startedAt: number; endedAt: number };
  command?: { name: string; ms: number; startedAt: number };
  /**
   * Warm continuation only: the instant this turn's generation was dispatched to
   * the live agent (ms epoch). Splits the leading pre-generation span into real
   * pickup (`queue`, windowStart->dispatchedAt). Provider first-response wait is
   * folded into the following LLM section as detail, keeping the timeline
   * architecture-level rather than exposing provider internals as a separate
   * stage.
   */
  dispatchedAt?: number;
}

export interface OperationalTimelineSectionInput {
  kind: OperationalTimelineSectionKind;
  label?: string;
  ms: number;
  startedAt: number;
  detail?: Record<string, unknown>;
  payload?: TracePayloadEnvelope;
}

type NamedSpanKind = Exclude<TimelineSectionKind, 'queue' | 'gap'>;

interface NamedSpan {
  kind: NamedSpanKind;
  label: string;
  start: number;
  end: number;
  detail: Record<string, unknown>;
  payload?: StagePayloadSource;
}

function defaultOperationalLabel(kind: OperationalTimelineSectionKind): string {
  return kind.replaceAll('_', ' ');
}

/** Ordered, time-sorted named spans from the capture sources (no gaps yet). */
function buildNamedSpans(input: AssembleTimelineInput): NamedSpan[] {
  const spans: NamedSpan[] = [];
  if (input.command) {
    spans.push({
      kind: 'command',
      label: input.command.name,
      start: input.command.startedAt,
      end: input.command.startedAt + input.command.ms,
      detail: { name: input.command.name },
    });
  }
  (input.operationalSections ?? []).forEach((section) => {
    spans.push({
      kind: section.kind,
      label: section.label ?? defaultOperationalLabel(section.kind),
      start: section.startedAt,
      end: section.startedAt + section.ms,
      detail: section.detail ?? {},
      payload: section.payload,
    });
  });
  if (input.guardrail) {
    spans.push({
      kind: 'guardrail',
      label: 'guardrail',
      start: input.guardrail.startedAt,
      end: input.guardrail.startedAt + input.guardrail.ms,
      detail: input.guardrail.detail,
    });
  }
  if (input.startup && input.startup.readyAt > input.startup.startedAt) {
    spans.push({
      kind: 'startup',
      label: 'assistant startup',
      start: input.startup.startedAt,
      end: input.startup.readyAt,
      detail: {},
    });
  }
  (input.llmTurns ?? []).forEach((turn, i) => {
    spans.push({
      kind: 'llm',
      label: `main LLM · turn ${i + 1}`,
      start: turn.startedAt,
      end: turn.startedAt + turn.ms,
      detail: turn.detail,
      payload: { input: turn.input, output: turn.output },
    });
  });
  (input.toolCalls ?? []).forEach((call) => {
    spans.push({
      kind: 'tool',
      label: call.tool,
      start: call.startedAt,
      end: call.startedAt + call.ms,
      detail: {
        server: call.server,
        tool: call.tool,
        ok: call.ok,
        ...(call.status !== undefined ? { status: call.status } : {}),
        requestBytes: call.requestBytes,
        responseBytes: call.responseBytes,
      },
      payload: { request: call.request, response: call.response },
    });
  });
  if (input.send && input.send.endedAt > input.send.startedAt) {
    spans.push({
      kind: 'send',
      label: 'send',
      start: input.send.startedAt,
      end: input.send.endedAt,
      detail: {},
    });
  }
  return spans.sort((a, b) => a.start - b.start);
}

interface BuiltTimeline {
  timeline: LatencyTimeline;
  /** Aligned 1:1 with timeline.sections by index; undefined where no payload. */
  payloadSources: (StagePayloadSource | undefined)[];
}

/** Core partition routine shared by assembleTimeline + assembleTimelinePayloads. */
function buildTimeline(input: AssembleTimelineInput): BuiltTimeline {
  const spans = buildNamedSpans(input);
  const earliest = spans.length ? spans[0]!.start : (input.windowStart ?? 0);
  const latest = spans.length
    ? Math.max(...spans.map((s) => s.end))
    : (input.windowEnd ?? 0);
  const windowStart = input.windowStart ?? earliest;
  const windowEnd = Math.max(input.windowEnd ?? latest, windowStart);

  const sections: TimelineSection[] = [];
  const payloadSources: (StagePayloadSource | undefined)[] = [];
  let cursor = windowStart;

  const pushGap = (gapStart: number, gapEnd: number) => {
    const ms = gapEnd - gapStart;
    if (ms <= 0) return;
    // The leading gap (still at windowStart) is queue time; other unnamed spans
    // are runtime hand-off/overhead. Provider first-response wait is folded into
    // the following LLM section instead of emitted as its own architecture stage.
    const kind: TimelineSectionKind = gapStart <= windowStart ? 'queue' : 'gap';
    const label = kind === 'queue' ? 'queue' : 'gap';
    sections.push({ kind, label, ms, startedAt: gapStart, detail: {} });
    payloadSources.push(undefined);
  };

  // Warm continuation: no startup span exists, so the whole pre-generation span
  // would otherwise be labelled `queue`. Split it at the dispatch instant so the
  // true pickup remains queue and the provider first-response wait folds into the
  // first LLM section. Bounded so a stale or out-of-range dispatch mark is
  // ignored (falls back to a single queue).
  const firstSpanStart = spans.length ? spans[0]!.start : windowEnd;
  if (
    input.dispatchedAt !== undefined &&
    input.dispatchedAt > windowStart &&
    input.dispatchedAt <= firstSpanStart &&
    input.dispatchedAt < windowEnd
  ) {
    pushGap(windowStart, input.dispatchedAt);
    cursor = input.dispatchedAt;
  }

  for (const span of spans) {
    const start = Math.min(Math.max(span.start, cursor), windowEnd);
    const end = Math.min(Math.max(span.end, start), windowEnd);
    const canFoldProviderWait =
      span.kind === 'llm' && end > start && cursor > windowStart;
    const providerWaitMs = canFoldProviderWait ? start - cursor : 0;
    const sectionStartedAt =
      canFoldProviderWait && providerWaitMs > 0 ? cursor : start;
    if (start > cursor && !canFoldProviderWait) pushGap(cursor, start);
    if (end > start) {
      sections.push({
        kind: span.kind,
        label: span.label,
        ms: end - sectionStartedAt,
        startedAt: sectionStartedAt,
        detail:
          span.kind === 'llm' && providerWaitMs > 0
            ? {
                ...span.detail,
                providerWaitMs,
                generationMs: end - start,
              }
            : span.detail,
      });
      payloadSources.push(span.payload);
    }
    // Always advance past this span — even a dropped 0ms named span — so the
    // NEXT gap measures from here, not from the old cursor. Without this a
    // dropped span (e.g. a 0ms deterministic guardrail) leaves the cursor at
    // windowStart and the next gap re-spans the window, duplicating `queue` and
    // breaking the sum-to-total invariant.
    cursor = Math.max(cursor, end);
  }
  if (cursor < windowEnd) pushGap(cursor, windowEnd);

  return {
    timeline: {
      version: 2,
      windowStart,
      windowEnd,
      totalMs: windowEnd - windowStart,
      ...(input.llmUsage ? { llmUsage: input.llmUsage } : {}),
      sections,
    },
    payloadSources,
  };
}

/** Build the always-written v2 `timings_json`. Pure, best-effort, never throws. */
export function assembleTimeline(
  input: AssembleTimelineInput,
): LatencyTimeline {
  return buildTimeline(input).timeline;
}

/** Flag-gated payloads, keyed by the v2 section index (aligns with assembleTimeline). */
export function assembleTimelinePayloads(
  input: AssembleTimelineInput,
): TracePayloadsByStage {
  const { payloadSources } = buildTimeline(input);
  const payloads: TracePayloadsByStage = {};
  payloadSources.forEach((source, index) => {
    if (!source) return;
    payloads[index] = source;
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
