import { SpanStatusCode, type Span } from '@opentelemetry/api';

import { logger } from '../../../infrastructure/logging/logger.js';
import { normalizeModelUsage } from '../../../shared/model-usage.js';
import type { NormalizedModelUsage } from '../../../shared/model-catalog.js';
import {
  ATTR_COMPLETION,
  ATTR_PROMPT,
  boundedContent,
  MAX_ATTRIBUTE_CHARS,
  TRACE_CONTENT_MAX_CHARS,
  childContextFor,
  contentCaptureEnabled,
  getTurnSpan,
  registerDelegationToolSpan,
  registerTurnSpanEndCallback,
  settleDelegationToolSpan,
  tracer,
} from '../../../infrastructure/observability/tracing.js';
import {
  createSseAccumulator,
  createSseFrameSplitter,
  isOpenAiUsageOnlyFrame,
  type SseAccumulatorResult,
  type SseToolCall,
  type SseStreamKind,
} from './sse-accumulator.js';

export interface GatewayCallTokenContext {
  appId?: unknown;
  agentId?: unknown;
  runId?: unknown;
  jobId?: unknown;
  conversationId?: unknown;
  threadId?: unknown;
  apiKeyId?: string;
}

export interface GatewayStreamTap {
  transform: (chunk: Buffer) => Buffer;
  flush: () => Buffer;
}

export interface GatewayCallObservation {
  requestBody: Buffer;
  isStreaming: boolean;
  // Only engages for actual SSE responses — a streaming REQUEST can still get
  // a plain-JSON error body back, which the frame-aligned tap must not touch.
  streamTapFor: (
    contentType: string | null | undefined,
    status?: number,
  ) => GatewayStreamTap | undefined;
  finish: (input: {
    status: number;
    responseJson?: unknown;
    normalizedUsage?: NormalizedModelUsage;
    errorMessage?: string;
  }) => void;
}

function componentFor(token: GatewayCallTokenContext): string {
  if (token.apiKeyId) return 'llm-api';
  const runId = token.runId === undefined ? '' : String(token.runId);
  if (runId.startsWith('memory-query:')) return 'memory';
  if (runId.startsWith('permission-classifier:')) {
    return 'permission-classifier';
  }
  return 'unattributed';
}

function streamKindFor(pathname: string): SseStreamKind | undefined {
  if (pathname.includes('/chat/completions')) return 'openai';
  if (pathname.includes('/messages') && !pathname.includes('/count_tokens')) {
    return 'anthropic';
  }
  return undefined;
}

// Non-generation endpoints the gateway also proxies; tracing them as `chat`
// generations would corrupt call counts and usage rollups. Untraced in v1.
// Suffix-matched: substrings would false-positive on dynamic path segments
// (e.g. a Vertex project named `embeddings-prod`).
const NON_GENERATION_SUFFIXES = [
  '/embeddings',
  '/count_tokens',
  '/moderations',
  '/rerank',
];

// stream_options.include_usage is only injected for providers verified to
// accept it — an endpoint that rejects unknown fields would turn a valid
// call into a 4xx just because tracing is on. Everything else relies on the
// caller opting in (LangChain's ChatOpenAI does by default), and OpenRouter
// returns its usage frame natively without the flag.
const INJECT_STREAM_USAGE_PROVIDERS = new Set(['openai']);

// gen_ai.system identifies the PROVIDER (semconv well-known values where
// they exist); `kind` is only the wire format used for parsing.
const PROVIDER_SYSTEM_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  bedrock: 'aws.bedrock',
  vertex: 'gcp.vertex_ai',
  gemini: 'gcp.gemini',
};
const PROVIDER_NAME_MAP: Record<string, string> = {
  ...PROVIDER_SYSTEM_MAP,
  xai: 'x_ai',
};

const ATTR_INPUT_MESSAGES = 'gen_ai.input.messages';
const ATTR_OUTPUT_MESSAGES = 'gen_ai.output.messages';
const TRUNCATION_SUFFIX = '…[truncated]';
const MAX_TOOL_CALLS = 128;

interface ToolCall extends SseToolCall {
  id: string;
  name: string;
  choiceIndex?: number;
  complete: boolean;
}

interface ToolResult {
  id: string;
  content: unknown;
  status: 'success' | 'error' | 'unknown';
}

interface PendingToolSpan {
  span: Span;
  startedAt: number;
  delegation: boolean;
  unregisterTurnEnd: () => void;
}

let pendingTracer: ReturnType<typeof tracer>;
const pendingToolsByRun = new Map<string, Map<string, PendingToolSpan>>();

function boundedTraceValue(
  value: unknown,
  stringLimit: number,
  arrayLimit: number,
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    return value.length > stringLimit
      ? `${value.slice(0, stringLimit)}${TRUNCATION_SUFFIX}`
      : value;
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= 8) return TRUNCATION_SUFFIX;
  if (Array.isArray(value)) {
    return value
      .slice(0, arrayLimit)
      .map((entry) =>
        boundedTraceValue(entry, stringLimit, arrayLimit, depth + 1),
      );
  }
  if (typeof value !== 'object') return String(value ?? '');
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (count >= 64) break;
    result[key] = boundedTraceValue(
      (value as Record<string, unknown>)[key],
      stringLimit,
      arrayLimit,
      depth + 1,
    );
    count += 1;
  }
  return result;
}

function boundedMessageJson(
  messages: Record<string, unknown>[],
  schema: 'legacy' | 'current-input' | 'current-output',
): string {
  let stringLimit = TRACE_CONTENT_MAX_CHARS;
  let arrayLimit = 64;
  let messageLimit = Math.min(MAX_TOOL_CALLS, messages.length);
  for (;;) {
    const bounded = messages
      .slice(-messageLimit)
      .map((message) => boundedTraceValue(message, stringLimit, arrayLimit));
    const serialized = JSON.stringify(bounded);
    if (serialized.length <= MAX_ATTRIBUTE_CHARS) return serialized;
    if (stringLimit > 256) stringLimit = Math.floor(stringLimit / 2);
    else if (arrayLimit > 1) arrayLimit = Math.floor(arrayLimit / 2);
    else if (messageLimit > 1) messageLimit = Math.floor(messageLimit / 2);
    else {
      if (schema === 'legacy') {
        return JSON.stringify([
          { role: 'unknown', content: TRUNCATION_SUFFIX },
        ]);
      }
      return JSON.stringify([
        {
          role: 'unknown',
          parts: [{ type: 'text', content: TRUNCATION_SUFFIX }],
          ...(schema === 'current-output'
            ? {
                finish_reason:
                  typeof messages.at(-1)?.finish_reason === 'string'
                    ? messages.at(-1)!.finish_reason
                    : 'error',
              }
            : {}),
        },
      ]);
    }
  }
}

function visibleAnthropicBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  const visible: Record<string, unknown>[] = [];
  for (const value of content) {
    if (visible.length >= MAX_TOOL_CALLS) break;
    if (!value || typeof value !== 'object') continue;
    const block = value as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      visible.push({ ...block, type: 'text', text: block.text });
    } else if (
      block.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      visible.push({
        ...block,
        type: 'tool_use',
        id: block.id,
        name: block.name,
      });
    } else if (
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string'
    ) {
      visible.push({
        ...block,
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
      });
    } else if (
      typeof block.type === 'string' &&
      block.type !== 'thinking' &&
      block.type !== 'redacted_thinking'
    ) {
      visible.push({ ...block });
    }
  }
  return visible;
}

function visibleOpenAiParts(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  const visible: Record<string, unknown>[] = [];
  for (const value of content) {
    if (visible.length >= MAX_TOOL_CALLS) break;
    if (!value || typeof value !== 'object') continue;
    const part = value as Record<string, unknown>;
    if (
      ![
        'text',
        'image_url',
        'input_audio',
        'audio',
        'file',
        'refusal',
      ].includes(String(part.type))
    ) {
      continue;
    }
    visible.push({ ...part });
  }
  return visible;
}

function legacyMessages(
  kind: SseStreamKind | undefined,
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (kind !== 'anthropic' && kind !== 'openai') return messages;
  return messages.map((message) => {
    const legacy = { ...message };
    delete legacy.finish_reason;
    delete legacy.index;
    return {
      ...legacy,
      ...(Array.isArray(message.content)
        ? {
            content:
              kind === 'anthropic'
                ? visibleAnthropicBlocks(message.content)
                : visibleOpenAiParts(message.content),
          }
        : {}),
    };
  });
}

function normalizedMessages(
  kind: SseStreamKind | undefined,
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  const normalized: Record<string, unknown>[] = [];
  for (const message of messages) {
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const parts: Record<string, unknown>[] = [];
    if (kind === 'anthropic' && Array.isArray(message.content)) {
      for (const block of visibleAnthropicBlocks(message.content)) {
        if (block.type === 'text') {
          parts.push({ type: 'text', content: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({
            type: 'tool_call',
            id: block.id,
            name: block.name,
            arguments: block.input ?? {},
          });
        } else if (block.type === 'tool_result') {
          parts.push({
            type: 'tool_call_response',
            id: block.tool_use_id,
            response: block.content ?? '',
          });
        } else {
          parts.push(block);
        }
      }
    } else if (role === 'tool' && typeof message.tool_call_id === 'string') {
      parts.push({
        type: 'tool_call_response',
        id: message.tool_call_id,
        response:
          message.content === undefined ? '' : parsedJson(message.content),
      });
    } else {
      if (typeof message.content === 'string') {
        parts.push({ type: 'text', content: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of visibleOpenAiParts(message.content)) {
          if (part.type === 'text' && typeof part.text === 'string') {
            parts.push({ type: 'text', content: part.text });
          } else {
            parts.push(part);
          }
        }
      }
      if (Array.isArray(message.tool_calls)) {
        for (const value of message.tool_calls.slice(0, MAX_TOOL_CALLS)) {
          if (!value || typeof value !== 'object') continue;
          const toolCall = value as Record<string, unknown>;
          const fn = toolCall.function as Record<string, unknown> | undefined;
          if (typeof toolCall.id !== 'string' || typeof fn?.name !== 'string') {
            continue;
          }
          parts.push({
            type: 'tool_call',
            id: toolCall.id,
            name: fn.name,
            arguments: parsedJson(fn.arguments) ?? {},
          });
        }
      }
      if (typeof message.refusal === 'string') {
        parts.push({ type: 'refusal', refusal: message.refusal });
      }
    }
    if (parts.length === 0) continue;
    normalized.push({
      role: parts.every((part) => part.type === 'tool_call_response')
        ? 'tool'
        : role,
      parts,
      ...(typeof message.index === 'number' ? { index: message.index } : {}),
      ...(typeof message.finish_reason === 'string'
        ? { finish_reason: message.finish_reason }
        : {}),
    });
  }
  return normalized;
}

function setMessageAttributes(
  span: Span,
  legacyKey: string,
  currentKey: string,
  messages: Record<string, unknown>[],
  kind: SseStreamKind | undefined,
): void {
  span.setAttribute(
    legacyKey,
    boundedMessageJson(legacyMessages(kind, messages), 'legacy'),
  );
  const current = normalizedMessages(kind, messages);
  const schemaComplete =
    currentKey !== ATTR_OUTPUT_MESSAGES ||
    current.every((message) => typeof message.finish_reason === 'string');
  if (current.length > 0 && schemaComplete) {
    span.setAttribute(
      currentKey,
      boundedMessageJson(
        current,
        currentKey === ATTR_OUTPUT_MESSAGES
          ? 'current-output'
          : 'current-input',
      ),
    );
  }
}

function providerSystemFor(providerId: string): string {
  return PROVIDER_SYSTEM_MAP[providerId] ?? providerId;
}

function providerNameFor(providerId: string): string {
  return PROVIDER_NAME_MAP[providerId] ?? providerId;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function promptMessages(
  request: Record<string, unknown>,
): Record<string, unknown>[] {
  const messages = Array.isArray(request.messages)
    ? (request.messages as Record<string, unknown>[])
    : [];
  const system = request.system;
  const hasSystem = typeof system === 'string' || Array.isArray(system);
  const entries: Record<string, unknown>[] = messages
    .slice(hasSystem ? -63 : -64)
    .filter(
      (message): message is Record<string, unknown> =>
        message !== null && typeof message === 'object',
    )
    .map((message) => ({
      role: typeof message.role === 'string' ? message.role : 'unknown',
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.tool_calls !== undefined
        ? { tool_calls: message.tool_calls }
        : {}),
      ...(message.tool_call_id !== undefined
        ? { tool_call_id: message.tool_call_id }
        : {}),
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.refusal !== undefined ? { refusal: message.refusal } : {}),
    }));
  if (typeof system === 'string') {
    entries.unshift({ role: 'system', content: system });
  } else if (Array.isArray(system)) {
    entries.unshift({ role: 'system', content: system });
  }
  return entries;
}

function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function responseAssistantMessages(
  kind: SseStreamKind | undefined,
  response: Record<string, unknown>,
): Record<string, unknown>[] {
  if (kind === 'anthropic' && Array.isArray(response.content)) {
    const blocks = visibleAnthropicBlocks(response.content);
    if (blocks.length === 0) return [];
    if (blocks.every((block) => block.type === 'text')) {
      let text = '';
      for (const block of blocks) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        const remaining = TRACE_CONTENT_MAX_CHARS + 1 - text.length;
        if (remaining <= 0) break;
        text += block.text.slice(0, remaining);
      }
      if (!text) return [];
      return [
        {
          role: 'assistant',
          content: boundedContent(text),
          ...(typeof response.stop_reason === 'string'
            ? { finish_reason: response.stop_reason }
            : {}),
        },
      ];
    }
    return [
      {
        role: 'assistant',
        content: blocks,
        ...(typeof response.stop_reason === 'string'
          ? { finish_reason: response.stop_reason }
          : {}),
      },
    ];
  }
  if (kind === 'openai') {
    const messages: Record<string, unknown>[] = [];
    for (const [position, choice] of (
      (response.choices as Record<string, unknown>[] | undefined) ?? []
    )
      .slice(0, MAX_TOOL_CALLS)
      .entries()) {
      const message = choice.message;
      if (!message || typeof message !== 'object') continue;
      const record = message as Record<string, unknown>;
      messages.push({
        ...(record.content !== undefined ? { content: record.content } : {}),
        ...(record.tool_calls !== undefined
          ? { tool_calls: record.tool_calls }
          : {}),
        ...(record.name !== undefined ? { name: record.name } : {}),
        ...(record.refusal !== undefined ? { refusal: record.refusal } : {}),
        role: typeof record.role === 'string' ? record.role : 'assistant',
        index: numeric(choice.index) ?? position,
        ...(typeof choice.finish_reason === 'string'
          ? { finish_reason: choice.finish_reason }
          : {}),
      });
    }
    return messages;
  }
  return [];
}

function responseToolCalls(
  kind: SseStreamKind | undefined,
  response: Record<string, unknown>,
): ToolCall[] {
  if (kind === 'anthropic' && Array.isArray(response.content)) {
    const calls: ToolCall[] = [];
    for (const block of response.content as Record<string, unknown>[]) {
      if (calls.length >= MAX_TOOL_CALLS) break;
      if (
        block.type !== 'tool_use' ||
        typeof block.id !== 'string' ||
        typeof block.name !== 'string'
      ) {
        continue;
      }
      calls.push({
        id: boundedToolIdentity(block.id),
        name: boundedToolIdentity(block.name),
        arguments: boundedToolValue(block.input),
        complete: response.stop_reason === 'tool_use',
      });
    }
    return calls;
  }
  if (kind !== 'openai') return [];
  const calls: ToolCall[] = [];
  for (const [position, choice] of (
    (response.choices as Record<string, unknown>[] | undefined) ?? []
  )
    .slice(0, MAX_TOOL_CALLS)
    .entries()) {
    const message = choice.message as Record<string, unknown> | undefined;
    if (!Array.isArray(message?.tool_calls)) continue;
    const choiceIndex = numeric(choice.index) ?? position;
    for (const toolCall of message.tool_calls as Record<string, unknown>[]) {
      if (calls.length >= MAX_TOOL_CALLS) return calls;
      const fn = toolCall.function as Record<string, unknown> | undefined;
      if (typeof toolCall.id !== 'string' || typeof fn?.name !== 'string') {
        continue;
      }
      calls.push({
        id: boundedToolIdentity(toolCall.id),
        name: boundedToolIdentity(fn.name),
        arguments: boundedToolValue(parsedJson(fn.arguments)),
        choiceIndex,
        complete: choice.finish_reason === 'tool_calls',
      });
    }
  }
  return calls;
}

function requestToolResults(
  kind: SseStreamKind | undefined,
  request: Record<string, unknown>,
): ToolResult[] {
  if (!Array.isArray(request.messages)) return [];
  const results: ToolResult[] = [];
  for (
    let index = request.messages.length - 1;
    index >= 0 && results.length < MAX_TOOL_CALLS;
    index -= 1
  ) {
    const value = request.messages[index];
    if (!value || typeof value !== 'object') continue;
    const message = value as Record<string, unknown>;
    if (kind === 'anthropic' && Array.isArray(message.content)) {
      for (
        let blockIndex = message.content.length - 1;
        blockIndex >= 0 && results.length < MAX_TOOL_CALLS;
        blockIndex -= 1
      ) {
        const value = message.content[blockIndex];
        if (!value || typeof value !== 'object') continue;
        const block = value as Record<string, unknown>;
        if (
          block.type !== 'tool_result' ||
          typeof block.tool_use_id !== 'string'
        ) {
          continue;
        }
        results.push({
          id: boundedToolIdentity(block.tool_use_id),
          content: block.content,
          status: block.is_error === true ? 'error' : 'success',
        });
      }
    } else if (
      kind === 'openai' &&
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string'
    ) {
      const content = parsedJson(message.content);
      const resultRecord =
        content && typeof content === 'object'
          ? (content as Record<string, unknown>)
          : undefined;
      const errorMarker =
        message.is_error ?? resultRecord?.is_error ?? resultRecord?.isError;
      results.push({
        id: boundedToolIdentity(message.tool_call_id),
        content,
        status:
          errorMarker === true
            ? 'error'
            : errorMarker === false
              ? 'success'
              : 'unknown',
      });
    }
  }
  return results.reverse();
}

function setUsageAttributes(
  span: Span,
  usage: Record<string, unknown>,
  kind: SseStreamKind | undefined,
): void {
  const input = numeric(usage.input_tokens) ?? numeric(usage.prompt_tokens);
  const output =
    numeric(usage.output_tokens) ?? numeric(usage.completion_tokens);
  const cacheRead = numeric(usage.cache_read_input_tokens);
  const cacheWrite = numeric(usage.cache_creation_input_tokens);
  if (input !== undefined)
    span.setAttribute(
      'gen_ai.usage.input_tokens',
      kind === 'anthropic'
        ? input + (cacheRead ?? 0) + (cacheWrite ?? 0)
        : input,
    );
  if (output !== undefined) {
    span.setAttribute('gen_ai.usage.output_tokens', output);
  }
  const total = numeric(usage.total_tokens);
  if (total !== undefined) {
    span.setAttribute('gen_ai.usage.total_tokens', total);
  }
  if (cacheRead !== undefined) {
    span.setAttribute('gen_ai.usage.cache_read_input_tokens', cacheRead);
    span.setAttribute('gen_ai.usage.cache_read.input_tokens', cacheRead);
  }
  if (cacheWrite !== undefined) {
    span.setAttribute('gen_ai.usage.cache_creation_input_tokens', cacheWrite);
    span.setAttribute('gen_ai.usage.cache_creation.input_tokens', cacheWrite);
  }
  const details = usage.prompt_tokens_details as
    | Record<string, unknown>
    | undefined;
  const cached = numeric(details?.cached_tokens);
  if (cached !== undefined) {
    span.setAttribute('gen_ai.usage.cached_tokens', cached);
  }
}

function setNormalizedUsageAttributes(
  span: Span,
  usage: NormalizedModelUsage,
  kind: SseStreamKind | undefined,
  rawUsage?: Record<string, unknown>,
): void {
  const rawInput = numeric(rawUsage?.input_tokens);
  const rawCacheRead = numeric(rawUsage?.cache_read_input_tokens);
  const rawCacheWrite = numeric(rawUsage?.cache_creation_input_tokens);
  span.setAttribute(
    'gen_ai.usage.input_tokens',
    kind === 'anthropic'
      ? (rawInput ?? usage.inputTokens) +
          (rawCacheRead ?? usage.cacheReadTokens) +
          (rawCacheWrite ?? usage.cacheWriteTokens)
      : usage.inputTokens,
  );
  span.setAttribute('gen_ai.usage.output_tokens', usage.outputTokens);
  if (usage.cacheReadTokens > 0) {
    span.setAttribute(
      'gen_ai.usage.cache_read_input_tokens',
      usage.cacheReadTokens,
    );
    span.setAttribute(
      'gen_ai.usage.cache_read.input_tokens',
      usage.cacheReadTokens,
    );
  }
  if (usage.cacheWriteTokens > 0) {
    span.setAttribute(
      'gen_ai.usage.cache_creation_input_tokens',
      usage.cacheWriteTokens,
    );
    span.setAttribute(
      'gen_ai.usage.cache_creation.input_tokens',
      usage.cacheWriteTokens,
    );
  }
}

function boundedToolValue(value: unknown): unknown {
  let stringLimit = TRACE_CONTENT_MAX_CHARS;
  let arrayLimit = 64;
  for (;;) {
    const bounded = boundedTraceValue(value ?? null, stringLimit, arrayLimit);
    if (JSON.stringify(bounded).length <= TRACE_CONTENT_MAX_CHARS) {
      return bounded;
    }
    if (stringLimit > 256) stringLimit = Math.floor(stringLimit / 2);
    else if (arrayLimit > 1) arrayLimit = Math.floor(arrayLimit / 2);
    else return { truncated: true };
  }
}

function boundedToolJson(value: unknown): string {
  return JSON.stringify(boundedToolValue(value));
}

function boundedToolIdentity(value: string): string {
  return value.length <= TRACE_CONTENT_MAX_CHARS
    ? value
    : `${value.slice(
        0,
        TRACE_CONTENT_MAX_CHARS - TRUNCATION_SUFFIX.length,
      )}${TRUNCATION_SUFFIX}`;
}

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

function finishPendingToolSpans(
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

function startPendingToolSpans(input: {
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

function failPendingToolSpans(
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

function streamedToolCalls(
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

function injectIncludeUsage(
  request: Record<string, unknown>,
): Buffer | undefined {
  const streamOptions = request.stream_options as
    | Record<string, unknown>
    | undefined;
  if (streamOptions && Object.hasOwn(streamOptions, 'include_usage')) {
    return undefined;
  }
  try {
    return Buffer.from(
      JSON.stringify({
        ...request,
        stream_options: { ...(streamOptions ?? {}), include_usage: true },
      }),
      'utf8',
    );
  } catch {
    return undefined;
  }
}

export function observeGatewayCall(input: {
  token: GatewayCallTokenContext;
  providerId: string;
  upstreamUrl: URL;
  requestBody: Buffer;
}): GatewayCallObservation | undefined {
  const activeTracer = tracer();
  if (!activeTracer) return undefined;
  if (pendingTracer !== activeTracer) {
    pendingTracer = activeTracer;
    pendingToolsByRun.clear();
  }
  let startedSpan: Span | undefined;
  try {
    let request: Record<string, unknown> = {};
    try {
      request = JSON.parse(input.requestBody.toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // Non-JSON body: still trace timing/status.
    }
    if (
      NON_GENERATION_SUFFIXES.some((suffix) =>
        input.upstreamUrl.pathname.endsWith(suffix),
      )
    ) {
      return undefined;
    }
    const kind = streamKindFor(input.upstreamUrl.pathname);
    const isStreaming = request.stream === true;
    const requestModel =
      typeof request.model === 'string' ? request.model : undefined;
    const captureContent = contentCaptureEnabled();

    const runId =
      input.token.runId === undefined ? undefined : String(input.token.runId);
    if (runId) {
      finishPendingToolSpans(runId, kind, request, captureContent);
    }
    const parent = runId ? getTurnSpan(runId) : undefined;
    // Span names bypass the attribute length limit; model comes from an
    // untrusted request body.
    const span = (startedSpan = activeTracer.startSpan(
      `chat ${(requestModel ?? input.providerId).slice(0, 128)}`,
      {
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': providerNameFor(input.providerId),
          'gen_ai.system': providerSystemFor(input.providerId),
          ...(requestModel ? { 'gen_ai.request.model': requestModel } : {}),
          ...(numeric(request.max_tokens) !== undefined
            ? { 'gen_ai.request.max_tokens': numeric(request.max_tokens)! }
            : {}),
          ...(numeric(request.temperature) !== undefined
            ? { 'gen_ai.request.temperature': numeric(request.temperature)! }
            : {}),
          'server.address': input.upstreamUrl.host,
          'gantry.provider_id': input.providerId,
          ...(parent ? {} : { 'gantry.component': componentFor(input.token) }),
          ...(input.token.appId
            ? { 'gantry.app_id': String(input.token.appId) }
            : {}),
          ...(input.token.agentId
            ? { 'gantry.agent_id': String(input.token.agentId) }
            : {}),
          ...(runId ? { 'gantry.run_id': runId } : {}),
          ...(input.token.jobId
            ? { 'gantry.job_id': String(input.token.jobId) }
            : {}),
          ...(input.token.threadId
            ? { 'gantry.thread_id': String(input.token.threadId) }
            : {}),
          ...(input.token.conversationId
            ? { 'session.id': String(input.token.conversationId) }
            : {}),
        },
      },
      parent ? childContextFor(parent) : undefined,
    ));
    // Sampled-out span: no observability data will export, so the request
    // must pass through byte-identical — no usage injection, no stream tap.
    if (!span.isRecording()) {
      span.end();
      return undefined;
    }
    let requestBody = input.requestBody;
    let injectedUsage = false;
    if (
      kind === 'openai' &&
      isStreaming &&
      INJECT_STREAM_USAGE_PROVIDERS.has(input.providerId)
    ) {
      const rewritten = injectIncludeUsage(request);
      if (rewritten) {
        requestBody = rewritten;
        injectedUsage = true;
      }
    }
    if (captureContent) {
      const messages = promptMessages(request);
      if (messages.length > 0) {
        setMessageAttributes(
          span,
          ATTR_PROMPT,
          ATTR_INPUT_MESSAGES,
          messages,
          kind,
        );
      }
    }

    const accumulator =
      isStreaming && kind
        ? createSseAccumulator(kind, captureContent)
        : undefined;
    let tapUsed = false;
    let sawFirstChunk = false;
    let streamStatus: number | undefined;
    const earlyRegisteredToolCallIds = new Set<string>();

    const registerCompletedStreamToolCalls = () => {
      if (!accumulator?.takeToolCallsReady()) return;
      if (
        !runId ||
        streamStatus === undefined ||
        streamStatus < 200 ||
        streamStatus >= 300
      ) {
        return;
      }
      const streamed = accumulator.result();
      if (streamed.errorMessage) return;
      const liveParent = getTurnSpan(runId);
      if (!liveParent) return;
      const complete = streamedToolCalls(kind, streamed).filter(
        (call) => call.complete && !earlyRegisteredToolCallIds.has(call.id),
      );
      if (complete.length === 0) return;
      startPendingToolSpans({
        runId,
        parent: liveParent,
        activeTracer,
        toolCalls: complete,
        captureContent,
      });
      const pending = pendingToolsByRun.get(runId);
      for (const call of complete) {
        if (pending?.has(call.id)) earlyRegisteredToolCallIds.add(call.id);
      }
    };

    const markFirstChunk = () => {
      if (!sawFirstChunk) {
        sawFirstChunk = true;
        try {
          span.addEvent('gantry.first_response_byte');
        } catch {
          // fail-open
        }
      }
    };

    // In injectedUsage mode the tap must be frame-aligned so the synthetic
    // usage-only chunk (which the caller did not ask for) can be stripped
    // from the downstream stream. Frame delimiters are normalized to \n\n
    // on that path. Otherwise the tap is a pure byte pass-through.
    const buildStreamTap = (): GatewayStreamTap => {
      if (!injectedUsage || !accumulator) {
        return {
          transform: (chunk) => {
            tapUsed = true;
            markFirstChunk();
            try {
              accumulator?.push(chunk);
              registerCompletedStreamToolCalls();
            } catch {
              // fail-open
            }
            return chunk;
          },
          flush: () => {
            try {
              accumulator?.push(Buffer.from('\n\n'));
              registerCompletedStreamToolCalls();
            } catch {
              // fail-open
            }
            return Buffer.alloc(0);
          },
        };
      }
      const splitter = createSseFrameSplitter();
      // Once the splitter overflows (one giant unterminated frame), the tap
      // releases everything it buffered and degrades to raw pass-through —
      // bytes must never be withheld from the client.
      let rawPassThrough = false;
      const processFrames = (frames: string[]) => {
        const out: string[] = [];
        for (const frame of frames) {
          accumulator.pushFrame(frame);
          registerCompletedStreamToolCalls();
          if (!isOpenAiUsageOnlyFrame(frame)) out.push(`${frame}\n\n`);
        }
        if (splitter.overflowed()) {
          rawPassThrough = true;
          out.push(splitter.takePending());
        }
        return Buffer.from(out.join(''), 'utf8');
      };
      return {
        transform: (chunk) => {
          tapUsed = true;
          markFirstChunk();
          if (rawPassThrough) return chunk;
          try {
            return processFrames(splitter.push(chunk));
          } catch {
            return chunk;
          }
        },
        flush: () => {
          if (rawPassThrough) return Buffer.alloc(0);
          try {
            return processFrames(splitter.flush());
          } catch {
            return Buffer.alloc(0);
          }
        },
      };
    };

    let finished = false;
    const finish: GatewayCallObservation['finish'] = (result) => {
      if (finished) return;
      finished = true;
      try {
        span.setAttribute('http.response.status_code', result.status);
        let usage: Record<string, unknown> | undefined;
        let responseModel: string | undefined;
        let assistantMessages: Record<string, unknown>[] = [];
        let toolCalls: ToolCall[] = [];
        let finishReasons: string[] = [];
        let streamErrorMessage: string | undefined;
        if (tapUsed && accumulator) {
          const streamed = accumulator.result();
          usage = streamed.usage;
          responseModel = streamed.model;
          toolCalls = streamedToolCalls(kind, streamed);
          if (streamed.assistantMessages) {
            assistantMessages = streamed.assistantMessages;
          } else if (streamed.assistantMessage) {
            assistantMessages = [streamed.assistantMessage];
          } else if (streamed.completionText) {
            assistantMessages = [
              {
                role: 'assistant',
                content: streamed.completionText,
                ...(streamed.finishReason
                  ? { finish_reason: streamed.finishReason }
                  : {}),
              },
            ];
          }
          finishReasons =
            streamed.finishReasons ??
            (streamed.finishReason ? [streamed.finishReason] : []);
          streamErrorMessage = streamed.errorMessage;
        } else if (
          result.responseJson &&
          typeof result.responseJson === 'object'
        ) {
          const response = result.responseJson as Record<string, unknown>;
          usage =
            response.usage && typeof response.usage === 'object'
              ? (response.usage as Record<string, unknown>)
              : undefined;
          responseModel =
            typeof response.model === 'string' ? response.model : undefined;
          assistantMessages = captureContent
            ? responseAssistantMessages(kind, response)
            : [];
          toolCalls = responseToolCalls(kind, response);
          if (typeof response.stop_reason === 'string') {
            finishReasons = [response.stop_reason];
          } else {
            finishReasons = (
              (response.choices as Record<string, unknown>[] | undefined) ?? []
            )
              .slice(0, MAX_TOOL_CALLS)
              .flatMap((choice) =>
                typeof choice.finish_reason === 'string'
                  ? [choice.finish_reason]
                  : [],
              );
          }
          if (typeof response.id === 'string') {
            span.setAttribute('gen_ai.response.id', response.id);
          }
        }
        if (responseModel) {
          span.setAttribute('gen_ai.response.model', responseModel);
        }
        if (finishReasons.length > 0) {
          span.setAttribute('gen_ai.response.finish_reasons', finishReasons);
        }
        if (usage) setUsageAttributes(span, usage, kind);
        const normalized =
          result.normalizedUsage ??
          (usage
            ? normalizeModelUsage({
                message: { model: responseModel, usage },
                fallbackModel: responseModel ?? requestModel,
              })
            : undefined);
        if (normalized) {
          setNormalizedUsageAttributes(span, normalized, kind, usage);
        }
        if (typeof normalized?.estimatedCostUsd === 'number') {
          span.setAttribute('gen_ai.usage.cost', normalized.estimatedCostUsd);
        }
        if (captureContent && assistantMessages.length > 0) {
          setMessageAttributes(
            span,
            ATTR_COMPLETION,
            ATTR_OUTPUT_MESSAGES,
            assistantMessages,
            kind,
          );
        }
        // Provider and transport errors can arrive after valid-looking tool
        // fragments. Only a successful terminal tool-call response means a
        // tool execution could actually follow on the next request.
        const providerError = streamErrorMessage
          ? captureContent
            ? boundedContent(streamErrorMessage)
            : 'provider stream error'
          : undefined;
        const errorMessage = result.errorMessage
          ? boundedContent(result.errorMessage)
          : providerError;
        if (runId && errorMessage && earlyRegisteredToolCallIds.size > 0) {
          failPendingToolSpans(runId, earlyRegisteredToolCallIds);
        }
        const liveParent = runId ? getTurnSpan(runId) : undefined;
        const completeToolCalls = toolCalls.filter(
          (call) => call.complete && !earlyRegisteredToolCallIds.has(call.id),
        );
        if (
          runId &&
          liveParent &&
          result.status >= 200 &&
          result.status < 300 &&
          !errorMessage &&
          completeToolCalls.length > 0
        ) {
          startPendingToolSpans({
            runId,
            parent: liveParent,
            activeTracer,
            toolCalls: completeToolCalls,
            captureContent,
          });
        }
        // streamErrorMessage is provider-sourced and may echo request
        // content; with content capture off, record a stable label instead.
        // result.errorMessage is host/gateway-sourced (timeouts, statusText).
        if (result.status >= 400 || errorMessage) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
          if (errorMessage) {
            span.setAttribute('error.type', errorMessage);
          }
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'Failed to finalize LLM span');
      } finally {
        try {
          span.end();
        } catch {
          // fail-open
        }
      }
    };

    let cachedTap: GatewayStreamTap | undefined;
    return {
      requestBody,
      isStreaming,
      streamTapFor: (contentType, status) => {
        // Media types are case-insensitive (e.g. Text/Event-Stream).
        if (
          !isStreaming ||
          !contentType?.toLowerCase().includes('text/event-stream')
        ) {
          return undefined;
        }
        if (status !== undefined) streamStatus = status;
        cachedTap ??= buildStreamTap();
        return cachedTap;
      },
      finish,
    };
  } catch (err) {
    try {
      startedSpan?.end();
    } catch {
      // fail-open
    }
    logger.warn({ err: String(err) }, 'Failed to observe gateway call');
    return undefined;
  }
}
