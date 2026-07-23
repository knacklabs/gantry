import type { Span } from '@opentelemetry/api';

import type { NormalizedModelUsage } from '../../../shared/model-catalog.js';
import {
  ATTR_COMPLETION,
  ATTR_PROMPT,
  boundedContent,
  MAX_ATTRIBUTE_CHARS,
  TRACE_CONTENT_MAX_CHARS,
} from '../../../infrastructure/observability/tracing.js';
import type { SseStreamKind, SseToolCall } from './sse-accumulator.js';

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

export const ATTR_INPUT_MESSAGES = 'gen_ai.input.messages';
export const ATTR_OUTPUT_MESSAGES = 'gen_ai.output.messages';
export const TRUNCATION_SUFFIX = '…[truncated]';
export const MAX_TOOL_CALLS = 128;

export interface ToolCall extends SseToolCall {
  id: string;
  name: string;
  choiceIndex?: number;
  complete: boolean;
}

export interface ToolResult {
  id: string;
  content: unknown;
  status: 'success' | 'error' | 'unknown';
}

export function boundedTraceValue(
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

export function setMessageAttributes(
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

export function providerSystemFor(providerId: string): string {
  return PROVIDER_SYSTEM_MAP[providerId] ?? providerId;
}

export function providerNameFor(providerId: string): string {
  return PROVIDER_NAME_MAP[providerId] ?? providerId;
}

export function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function boundedToolValue(value: unknown): unknown {
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

export function boundedToolJson(value: unknown): string {
  return JSON.stringify(boundedToolValue(value));
}

export function boundedToolIdentity(value: string): string {
  return value.length <= TRACE_CONTENT_MAX_CHARS
    ? value
    : `${value.slice(
        0,
        TRACE_CONTENT_MAX_CHARS - TRUNCATION_SUFFIX.length,
      )}${TRUNCATION_SUFFIX}`;
}

export function promptMessages(
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

export function responseAssistantMessages(
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

export function responseToolCalls(
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

export function requestToolResults(
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

export function setUsageAttributes(
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

export function setNormalizedUsageAttributes(
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
