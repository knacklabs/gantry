import type {
  NormalizedCacheProvider,
  NormalizedCacheStatus,
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';
import type {
  RunnerOutputFrame,
  RunnerRuntimeEventFrame,
} from '../../../../runner/runner-frame.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import {
  buildTaskLifecycleRuntimeEvent,
  type TaskLifecycleContext,
  type TaskLifecycleEventInput,
} from '../../../../runner/task-lifecycle-events.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import {
  privateToolActivityInvocationIdFromResult,
  terminalToolActivityPayload,
} from '../../../../domain/events/tool-activity.js';
import {
  canonicalGantryToolRuleName,
  gantryOwnedToolActivityFamily,
} from '../../../../shared/gantry-tool-facades.js';
import {
  unprojectedAccessActivityDetail,
  unprojectedAccessIdentityFromToolResult,
} from '../../../../shared/unprojected-access.js';

// Pure normalizer: turns an async iterable of LangGraph `streamEvents` (v2)
// events into provider-neutral runner output frames. Kept free of any
// network/SDK construction so it is unit-testable against a mocked stream.
//
// Behavior mirrors the Anthropic runner streaming contract:
//   - text token deltas are emitted as intermediate frames
//     { status:'success', result:<delta>, newSessionId } so channels stream;
//   - the SINGLE per-turn terminal frame is NOT emitted here. The normalizer
//     returns the terminal payload (result text, usage, contextUsage) so the
//     caller (runner index) emits exactly one terminal marker per user-visible
//     turn, folding in the continuation/stop decision (R2). This mirrors the
//     Anthropic query-loop, which emits one `result` frame per inner turn that
//     carries usage, contextUsage, and `continuedByFollowup` together.
// usage_metadata (input_tokens/output_tokens) is accumulated across
// AIMessageChunks. Context-window figures come from the runtime model profile,
// never hardcoded.

export interface LangGraphStreamEvent {
  event: string;
  run_id?: string;
  // The runnable name on `on_tool_start`/`on_tool_end` events is the tool name.
  name?: string;
  data?: {
    chunk?: unknown;
    input?: unknown;
    output?: unknown;
  };
}

const GANTRY_TASK_LIFECYCLE_EVENT = Symbol('GantryTaskLifecycleStreamEvent');
const GANTRY_TASK_LIFECYCLE_EVENT_NAME = 'gantry_task_lifecycle';

interface GantryTaskLifecycleStreamEvent extends LangGraphStreamEvent {
  [GANTRY_TASK_LIFECYCLE_EVENT]: true;
}

export function buildGantryTaskLifecycleStreamEvent(
  input: TaskLifecycleEventInput,
): LangGraphStreamEvent {
  const event = {
    event: GANTRY_TASK_LIFECYCLE_EVENT_NAME,
    data: { output: input },
  } as GantryTaskLifecycleStreamEvent;
  Object.defineProperty(event, GANTRY_TASK_LIFECYCLE_EVENT, {
    value: true,
    enumerable: false,
  });
  return event;
}

export interface ModelProfileSnapshot {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface StreamNormalizerInput {
  events: AsyncIterable<LangGraphStreamEvent>;
  newSessionId: string;
  modelId?: string;
  modelProfile: ModelProfileSnapshot;
  // Prompt-cache provider for the resolved model, derived from the runner's
  // endpoint family on the HOST/runner (openrouter -> 'openrouter-provider',
  // openai -> 'openai'). The normalizer must not import the model catalog
  // (provider boundary), so the cache provider is passed in. When 'none' the
  // lane has no prompt cache and cache tokens are reported as zero/unsupported.
  cacheProvider?: NormalizedCacheProvider;
  emit: (frame: RunnerOutputFrame) => void;
  onFirstEvent?: (eventName: string) => void;
  onFirstVisibleText?: () => void;
  // Called with the tool name when a tool invocation starts. The scheduled-job
  // heartbeat uses this to mark tool activity so a long-running tool (e.g. the
  // shell tool) keeps the lease alive instead of looking idle.
  onToolStart?: (toolName: string) => void;
  shouldEmitToolOutcome?: (invocationId: string) => boolean;
  gantryOwnedToolNames?: ReadonlySet<string>;
  nextToolSequence?: () => number;
  runtimeEventContext?: TaskLifecycleContext & { parentTaskId?: string };
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  // Prompt-cache read/write tokens, read off the final/cumulative usage chunk.
  // OpenAI/Kimi cache automatically; reads land on
  // prompt_tokens_details.cached_tokens (raw) / input_token_details.cache_read
  // (LangChain). Only OpenRouter sub-models that support explicit cache_control
  // report writes (prompt_tokens_details.cache_write_tokens); OpenAI has none.
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// Terminal payload the caller folds into the single per-turn terminal frame.
export interface NormalizedTurnResult {
  text: string;
  usage: UsageAccumulator;
  // `result` to put on the terminal frame: the accumulated assistant text only
  // when no partial text was streamed (avoids double-rendering), else null.
  terminalResult: string | null;
  terminalUsage: NormalizedModelUsage;
  terminalContextUsage: RuntimeContextUsageSnapshot;
}

export async function normalizeDeepAgentStream(
  input: StreamNormalizerInput,
): Promise<NormalizedTurnResult> {
  const usage: UsageAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let accumulatedText = '';
  let sawPartialText = false;
  let sawFirstEvent = false;
  let sawFirstVisibleText = false;
  let toolSequence = 0;
  const pendingTools = new Map<
    string,
    Array<{ invocationId: string; tracerRunId?: string; seq: number }>
  >();
  const terminalToolIds = new Set<string>();
  const terminalProviderRunIds = new Set<string>();
  const nextToolSequence = () => input.nextToolSequence?.() ?? ++toolSequence;

  for await (const event of input.events) {
    if (!sawFirstEvent) {
      sawFirstEvent = true;
      input.onFirstEvent?.(event.event);
    }
    if (event.event === 'on_chat_model_stream') {
      const chunk = event.data?.chunk;
      accumulateUsageFromChunk(chunk, usage);
      const delta = textFromChunk(chunk);
      if (delta) {
        if (!sawFirstVisibleText) {
          sawFirstVisibleText = true;
          input.onFirstVisibleText?.();
        }
        accumulatedText += delta;
        sawPartialText = true;
        input.emit({
          status: 'success',
          result: delta,
          newSessionId: input.newSessionId,
        });
      }
      continue;
    }
    if (event.event === 'on_chat_model_end') {
      accumulateUsageFromChunk(event.data?.output, usage);
      continue;
    }
    if (event.event === 'on_tool_start' && typeof event.name === 'string') {
      input.onToolStart?.(event.name);
      const seq = nextToolSequence();
      const tracerRunId = event.run_id?.trim();
      const invocationId =
        providerToolCallInvocationId(event.data?.input) ||
        tracerRunId ||
        `${input.newSessionId}:tool:${seq}`;
      const pending = pendingTools.get(event.name) ?? [];
      pending.push({ invocationId, tracerRunId, seq });
      pendingTools.set(event.name, pending);
    }
    if (
      (event.event === 'on_tool_end' || event.event === 'on_tool_error') &&
      typeof event.name === 'string'
    ) {
      const pending = pendingTools.get(event.name) ?? [];
      const tracerRunId = event.run_id?.trim();
      const matchingPendingIndex = tracerRunId
        ? pending.findIndex((tool) => tool.tracerRunId === tracerRunId)
        : 0;
      const pendingTool =
        matchingPendingIndex >= 0
          ? pending.splice(matchingPendingIndex, 1)[0]
          : undefined;
      const seq = pendingTool?.seq ?? nextToolSequence();
      const family = input.gantryOwnedToolNames?.has(event.name)
        ? gantryOwnedToolActivityFamily(event.name)
        : undefined;
      const resultInvocationId = family
        ? privateToolActivityInvocationIdFromDeepAgentResult(event.data?.output)
        : undefined;
      const invocationId =
        resultInvocationId ||
        providerToolCallInvocationId(event.data?.output) ||
        pendingTool?.invocationId ||
        tracerRunId ||
        `${input.newSessionId}:tool:${seq}`;
      if (pending.length > 0) pendingTools.set(event.name, pending);
      else pendingTools.delete(event.name);
      if (
        !terminalToolIds.has(invocationId) &&
        (!tracerRunId || !terminalProviderRunIds.has(tracerRunId)) &&
        (input.shouldEmitToolOutcome?.(invocationId) ?? true) &&
        input.runtimeEventContext &&
        !input.runtimeEventContext.parentTaskId
      ) {
        terminalToolIds.add(invocationId);
        if (tracerRunId) terminalProviderRunIds.add(tracerRunId);
      const outcome =
          event.event === 'on_tool_error' ||
          toolResultIsError(event.data?.output)
            ? 'failure'
            : 'success';
        const unprojectedIdentity =
          family && isRequestAccessTool(event.name)
            ? unprojectedAccessIdentityFromDeepAgentResult(event.data?.output)
            : undefined;
        input.emit({
          status: 'success',
          result: null,
          newSessionId: input.newSessionId,
          runtimeEventOnly: true,
          runtimeEvents: [
            {
              ...input.runtimeEventContext,
              eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
              actor: input.runtimeEventContext.actor ?? 'deepagents',
              correlationId: invocationId,
              payload: terminalToolActivityPayload({
                invocationId,
                tool: canonicalGantryToolRuleName(event.name),
                ...(family ? { family } : {}),
                outcome,
                seq,
                ...(unprojectedIdentity
                  ? {
                      detail:
                        unprojectedAccessActivityDetail(unprojectedIdentity),
                    }
                  : {}),
              }),
            },
          ],
        });
      }
    }
    const taskEvent = taskLifecycleRuntimeEventFromStreamEvent(
      input.runtimeEventContext,
      event,
    );
    if (taskEvent) {
      input.emit({
        status: 'success',
        result: null,
        newSessionId: input.newSessionId,
        runtimeEventOnly: true,
        runtimeEvents: [taskEvent],
      });
    }
  }

  // The terminal frame is emitted by the caller (runner index) so there is
  // exactly one terminal marker per user-visible turn and it can carry the
  // continuation/stop decision. The normalizer only streams deltas.
  return {
    text: accumulatedText,
    usage,
    terminalResult: sawPartialText ? null : accumulatedText || null,
    terminalUsage: normalizedUsage(usage, input.modelId, input.cacheProvider),
    terminalContextUsage: contextUsageSnapshot(
      usage,
      input.modelId,
      input.modelProfile,
    ),
  };
}

function providerToolCallInvocationId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const directToolCallId = stringValue(record.tool_call_id);
  if (directToolCallId) return directToolCallId;
  if (record.type === 'tool_call') return stringValue(record.id);
  const toolCall =
    record.toolCall &&
    typeof record.toolCall === 'object' &&
    !Array.isArray(record.toolCall)
      ? (record.toolCall as Record<string, unknown>)
      : undefined;
  return stringValue(toolCall?.id);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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

function taskLifecycleRuntimeEventFromStreamEvent(
  context: TaskLifecycleContext | undefined,
  event: LangGraphStreamEvent,
): RunnerRuntimeEventFrame | null {
  if (!context || !isGantryTaskLifecycleStreamEvent(event)) return null;
  return buildTaskLifecycleRuntimeEvent(
    context,
    taskLifecycleInputFromValue(event.data?.output),
  );
}

function isGantryTaskLifecycleStreamEvent(
  event: LangGraphStreamEvent,
): event is GantryTaskLifecycleStreamEvent {
  return (
    event.event === GANTRY_TASK_LIFECYCLE_EVENT_NAME &&
    (event as { [GANTRY_TASK_LIFECYCLE_EVENT]?: boolean })[
      GANTRY_TASK_LIFECYCLE_EVENT
    ] === true
  );
}

function taskLifecycleInputFromValue(value: unknown): TaskLifecycleEventInput {
  if (!value || typeof value !== 'object') {
    return { kind: 'notification', taskId: '' };
  }
  const record = value as Record<string, unknown>;
  const kind = taskLifecycleKind(record.kind);
  const patch =
    record.patch && typeof record.patch === 'object'
      ? (record.patch as Record<string, unknown>)
      : {};
  return {
    kind,
    taskId: stringField(record, 'taskId') ?? '',
    toolUseId: stringField(record, 'toolUseId'),
    description: stringField(record, 'description'),
    subagentType: stringField(record, 'subagentType'),
    taskType: stringField(record, 'taskType'),
    workflowName: stringField(record, 'workflowName'),
    skipTranscript: record.skipTranscript === true,
    lastToolName: stringField(record, 'lastToolName'),
    summary: stringField(record, 'summary'),
    status: stringField(record, 'status'),
    usage: taskLifecycleUsage(record.usage),
    patch: {
      status: stringField(patch, 'status'),
      description: stringField(patch, 'description'),
      endTime: numberField(patch, 'endTime'),
      totalPausedMs: numberField(patch, 'totalPausedMs'),
      isBackgrounded:
        typeof patch.isBackgrounded === 'boolean'
          ? patch.isBackgrounded
          : undefined,
      hasError: patch.hasError === true,
    },
  };
}

function taskLifecycleKind(value: unknown): TaskLifecycleEventInput['kind'] {
  return value === 'started' ||
    value === 'progress' ||
    value === 'updated' ||
    value === 'notification'
    ? value
    : 'notification';
}

function taskLifecycleUsage(value: unknown): TaskLifecycleEventInput['usage'] {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return {
    totalTokens: numberField(record, 'totalTokens'),
    toolUses: numberField(record, 'toolUses'),
    durationMs: numberField(record, 'durationMs'),
  };
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field.trim().length > 0
    ? field
    : undefined;
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field)
    ? field
    : undefined;
}

function privateToolActivityInvocationIdFromDeepAgentResult(
  value: unknown,
): string | undefined {
  const direct = privateToolActivityInvocationIdFromResult(value);
  if (direct || !Array.isArray(value) || !Array.isArray(value[1])) {
    return direct;
  }
  // The MCP adapter projects the protocol-private `_meta` object as an
  // `mcp_meta` artifact while keeping it out of model-visible tool content.
  for (const artifact of value[1]) {
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      Array.isArray(artifact) ||
      (artifact as Record<string, unknown>).type !== 'mcp_meta'
    ) {
      continue;
    }
    return privateToolActivityInvocationIdFromResult({
      _meta: (artifact as Record<string, unknown>).data,
    });
  }
  return undefined;
}

function unprojectedAccessIdentityFromDeepAgentResult(
  value: unknown,
): string | undefined {
  const direct = unprojectedAccessIdentityFromToolResult(value);
  if (direct || !Array.isArray(value) || !Array.isArray(value[1])) {
    return direct;
  }
  for (const artifact of value[1]) {
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      Array.isArray(artifact) ||
      (artifact as Record<string, unknown>).type !== 'mcp_meta'
    ) {
      continue;
    }
    const identity = unprojectedAccessIdentityFromToolResult({
      _meta: (artifact as Record<string, unknown>).data,
    });
    if (identity) return identity;
  }
  return undefined;
}

function isRequestAccessTool(toolName: string): boolean {
  return (
    toolName === 'request_access' ||
    toolName === 'mcp__gantry__request_access'
  );
}

function textFromChunk(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const record = chunk as {
    content?: unknown;
    contentBlocks?: unknown;
    content_blocks?: unknown;
  };
  if (Array.isArray(record.contentBlocks)) {
    return textFromContent(record.contentBlocks);
  }
  if (Array.isArray(record.content_blocks)) {
    return textFromContent(record.content_blocks);
  }
  return textFromContent(record.content);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(textFromContentPart).join('');
  }
  return '';
}

function textFromContentPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (
    part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'text' &&
    typeof (part as { text?: unknown }).text === 'string'
  ) {
    return (part as { text: string }).text;
  }
  return '';
}

function accumulateUsageFromChunk(
  chunk: unknown,
  usage: UsageAccumulator,
): void {
  if (!chunk || typeof chunk !== 'object') return;
  const metadata = (chunk as { usage_metadata?: unknown }).usage_metadata;
  const input = readNumber(readPath(metadata, 'input_tokens'));
  const output = readNumber(readPath(metadata, 'output_tokens'));
  // usage_metadata on AIMessageChunks is cumulative for a single model turn, so
  // keep the largest seen rather than summing partial deltas.
  if (input > usage.inputTokens) usage.inputTokens = input;
  if (output > usage.outputTokens) usage.outputTokens = output;

  // Cache reads/writes ride on the final/cumulative chunk and are read off BOTH
  // shapes, preferring the raw provider fields when present:
  //   - raw provider usage on response_metadata.usage.prompt_tokens_details.*
  //     ({cached_tokens, cache_write_tokens}). ChatOpenAI surfaces this on its
  //     final empty chunk; the fake OpenRouter gateway also carries it. Writes
  //     are ONLY available here (no LangChain-normalized name exists).
  //   - LangChain's normalized usage_metadata.input_token_details.cache_read /
  //     .cache_creation. ChatOpenRouter only maps cached_tokens -> cache_read,
  //     so reads land here even when the raw usage is absent.
  const rawUsage = readPath(chunk, 'response_metadata.usage');
  // Cache-read field varies by upstream provider, so read the FIRST present:
  //   - prompt_tokens_details.cached_tokens (OpenAI / Groq / xAI / Fireworks /
  //     Cerebras / Gemini / OpenRouter — nested);
  //   - prompt_cache_hit_tokens (DeepSeek — flat, alongside
  //     prompt_cache_miss_tokens);
  //   - cached_tokens (Together — flat);
  //   - the LangChain-normalized usage_metadata.input_token_details.cache_read
  //     fallback.
  const cacheRead = firstFinite(
    readPath(rawUsage, 'prompt_tokens_details.cached_tokens'),
    readPath(rawUsage, 'prompt_cache_hit_tokens'),
    readPath(rawUsage, 'cached_tokens'),
    readPath(metadata, 'input_token_details.cache_read'),
  );
  const cacheWrite = firstFinite(
    readPath(rawUsage, 'prompt_tokens_details.cache_write_tokens'),
    readPath(metadata, 'input_token_details.cache_creation'),
  );
  // Cumulative-per-turn, same as input/output: keep the largest seen.
  if (cacheRead > usage.cacheReadTokens) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > usage.cacheWriteTokens) usage.cacheWriteTokens = cacheWrite;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// First finite number among the candidates (provider raw field preferred over
// the LangChain-normalized one). Returns 0 when none is a finite number.
function firstFinite(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

// Safe dotted-path read over an unknown object graph (mirrors the host
// normalizer's readPath in shared/model-usage.ts).
function readPath(input: unknown, path: string): unknown {
  let cursor = input;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function normalizedUsage(
  usage: UsageAccumulator,
  modelId: string | undefined,
  cacheProvider: NormalizedCacheProvider | undefined,
): NormalizedModelUsage {
  const provider = cacheProvider ?? 'none';
  // A prompt-cache lane (openai/openrouter-provider) supports cache accounting;
  // 'none' means the model has no prompt cache so reads/writes are unsupported.
  const supportsCacheAccounting = provider !== 'none';
  const cacheReadTokens = supportsCacheAccounting ? usage.cacheReadTokens : 0;
  const cacheWriteTokens = supportsCacheAccounting ? usage.cacheWriteTokens : 0;
  return {
    ...(modelId ? { model: modelId } : {}),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    // Cache reads are already counted inside input_tokens, so the billable
    // (non-cached) input is input - reads (mirrors the host normalizer).
    totalBillableInputTokens: supportsCacheAccounting
      ? Math.max(0, usage.inputTokens - cacheReadTokens)
      : usage.inputTokens,
    cacheProvider: provider,
    cacheStatus: cacheStatusFor(
      cacheReadTokens,
      cacheWriteTokens,
      supportsCacheAccounting,
    ),
    at: nowIso(),
  };
}

// Cache-status mapping identical to the host normalizer
// (shared/model-usage.ts normalizeCacheStatus): on a supported lane, reads+
// writes -> 'partial', reads -> 'hit', writes -> 'miss', neither -> 'unknown';
// an unsupported lane is always 'unsupported'.
function cacheStatusFor(
  read: number,
  write: number,
  supported: boolean,
): NormalizedCacheStatus {
  if (!supported) return 'unsupported';
  if (read > 0 && write > 0) return 'partial';
  if (read > 0) return 'hit';
  if (write > 0) return 'miss';
  return 'unknown';
}

function contextUsageSnapshot(
  usage: UsageAccumulator,
  modelId: string | undefined,
  profile: ModelProfileSnapshot,
): RuntimeContextUsageSnapshot {
  const maxTokens = profile.maxInputTokens ?? 0;
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const percentage =
    maxTokens > 0 ? Math.min(100, (totalTokens / maxTokens) * 100) : 0;
  return {
    totalTokens,
    maxTokens,
    percentage,
    ...(modelId ? { model: modelId } : {}),
    categories: [],
    apiUsage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
    },
    at: nowIso(),
  };
}
