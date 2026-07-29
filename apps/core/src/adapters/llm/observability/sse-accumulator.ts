import { TRACE_CONTENT_MAX_CHARS } from '../../../infrastructure/observability/tracing.js';
import {
  createSseFrameSplitter,
  MAX_PENDING_CHARS,
  sseFrameData,
} from './sse-frame-splitter.js';

export {
  createSseFrameSplitter,
  isOpenAiUsageOnlyFrame,
  sseFrameData,
  type SseFrameSplitter,
} from './sse-frame-splitter.js';

export type SseStreamKind = 'anthropic' | 'openai';

const MAX_COMPLETION_CHARS = 256 * 1024;
const MAX_TOOL_PAYLOAD_CHARS = 16 * 1024;
const MAX_AGGREGATE_TOOL_ARGUMENT_CHARS = 1024 * 1024;
const MAX_TOOL_IDENTITY_CHARS = TRACE_CONTENT_MAX_CHARS;
const MAX_TOOL_CALLS = 128;
const MAX_OPENAI_CHOICES = 128;
const TRUNCATED_SUFFIX = '…[truncated]';

export interface SseToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  mcpServer?: string;
  choiceIndex?: number;
  complete?: boolean;
  // Bounded, in-process-only hint used to correlate parallel delegation when
  // content export is disabled. Never written to span attributes/messages.
  correlationArguments?: unknown;
}

export interface SseAssistantMessage {
  [key: string]: unknown;
  role: 'assistant';
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type: 'function';
    function: { name?: string; arguments?: unknown };
  }>;
}

export interface SseAccumulatorResult {
  model?: string;
  usage?: Record<string, unknown>;
  completionText?: string;
  toolCalls?: SseToolCall[];
  assistantMessage?: SseAssistantMessage;
  assistantMessages?: SseAssistantMessage[];
  finishReason?: string;
  finishReasons?: string[];
  // Providers can fail mid-stream behind an HTTP 200 (top-level `error`
  // chunk / `error` event); spans must not export those as successes.
  errorMessage?: string;
}

export interface SseAccumulator {
  push: (chunk: Buffer) => void;
  pushFrame: (frame: string) => void;
  takeToolCallsReady: () => boolean;
  result: () => SseAccumulatorResult;
}

interface PendingToolCall {
  order: number;
  id?: string;
  name?: string;
  initialArguments?: unknown;
  argumentText: string;
  argumentCapped: boolean;
  sawArgumentDelta: boolean;
}

interface OpenAiChoiceState {
  index: number;
  completionText: string;
  completionCapped: boolean;
  refusalText: string;
  finishReason?: string;
  pendingToolCalls: Map<number, PendingToolCall>;
}

function boundedToolValue(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
}

function boundedStructuredValue(
  value: unknown,
  stringLimit: number,
  arrayLimit: number,
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    return boundedToolValue(value, stringLimit);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (depth >= 8) return TRUNCATED_SUFFIX;
  if (Array.isArray(value)) {
    return value
      .slice(0, arrayLimit)
      .map((entry) =>
        boundedStructuredValue(entry, stringLimit, arrayLimit, depth + 1),
      );
  }
  if (typeof value !== 'object') return String(value ?? '');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).slice(
    0,
    64,
  )) {
    result[key] = boundedStructuredValue(
      (value as Record<string, unknown>)[key],
      stringLimit,
      arrayLimit,
      depth + 1,
    );
  }
  return result;
}

function boundedStructuredArguments(value: unknown): unknown {
  let stringLimit = MAX_TOOL_PAYLOAD_CHARS;
  let arrayLimit = 64;
  for (;;) {
    const bounded = boundedStructuredValue(value, stringLimit, arrayLimit);
    if (JSON.stringify(bounded).length <= MAX_TOOL_PAYLOAD_CHARS) {
      return bounded;
    }
    if (stringLimit > 256) stringLimit = Math.floor(stringLimit / 2);
    else if (arrayLimit > 1) arrayLimit = Math.floor(arrayLimit / 2);
    else return { truncated: true };
  }
}

function structuredArguments(value: string): unknown {
  try {
    return boundedStructuredArguments(JSON.parse(value) as unknown);
  } catch {
    return boundedToolValue(value, MAX_TOOL_PAYLOAD_CHARS);
  }
}

function initialArguments(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return boundedStructuredArguments(value);
  } catch {
    return boundedToolValue(String(value), MAX_TOOL_PAYLOAD_CHARS);
  }
}

function isDelegationTool(name: string | undefined): boolean {
  if (!name) return false;
  const gantryName = name.startsWith('mcp__gantry__')
    ? name.slice('mcp__gantry__'.length)
    : name;
  return (
    gantryName === 'delegate_task' ||
    gantryName === 'AgentDelegation' ||
    gantryName === 'Agent' ||
    gantryName.startsWith('delegate_to_')
  );
}

export function createSseAccumulator(
  kind: SseStreamKind,
  captureContent: boolean,
): SseAccumulator {
  const splitter = createSseFrameSplitter();
  let dead = false;
  let done = false;
  let model: string | undefined;
  let completionText = '';
  let completionCapped = false;
  let finishReason: string | undefined;
  let errorMessage: string | undefined;
  const usage: Record<string, unknown> = {};
  let sawUsage = false;
  const pendingToolCalls = new Map<number, PendingToolCall>();
  const openAiChoices = new Map<number, OpenAiChoiceState>();
  const anthropicTextBlocks = new Map<number, string>();
  let retainedToolArgumentChars = 0;
  let retainedToolCalls = 0;
  let retainedOpenAiContentChars = 0;
  let toolCallsReady = false;

  const captureError = (value: unknown) => {
    if (errorMessage || value === null || typeof value !== 'object') return;
    const err = value as { message?: unknown; type?: unknown; code?: unknown };
    const parts = [err.type ?? err.code, err.message]
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .map(String);
    errorMessage = parts.length > 0 ? parts.join(': ') : 'stream error';
  };

  const appendText = (text: string): string => {
    if (!captureContent || completionCapped) return '';
    const before = completionText.length;
    completionText += text;
    if (completionText.length > MAX_COMPLETION_CHARS) {
      completionText = completionText.slice(0, MAX_COMPLETION_CHARS);
      completionCapped = true;
    }
    return completionText.slice(before);
  };

  const appendChoiceText = (choice: OpenAiChoiceState, text: string) => {
    if (!captureContent || choice.completionCapped) return;
    const available = MAX_COMPLETION_CHARS - retainedOpenAiContentChars;
    if (available <= 0) {
      choice.completionCapped = true;
      return;
    }
    const retained = text.slice(0, available);
    choice.completionText += retained;
    retainedOpenAiContentChars += retained.length;
    if (retained.length < text.length) choice.completionCapped = true;
  };

  const appendChoiceRefusal = (choice: OpenAiChoiceState, text: string) => {
    if (!captureContent) return;
    const available = MAX_COMPLETION_CHARS - retainedOpenAiContentChars;
    if (available <= 0) return;
    const retained = text.slice(0, available);
    choice.refusalText += retained;
    retainedOpenAiContentChars += retained.length;
  };

  const toolIndex = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : fallback;

  const getToolCall = (
    calls: Map<number, PendingToolCall>,
    index: number,
  ): PendingToolCall | undefined => {
    const current = calls.get(index);
    if (current) return current;
    if (retainedToolCalls >= MAX_TOOL_CALLS) return undefined;
    const created: PendingToolCall = {
      order: index,
      argumentText: '',
      argumentCapped: false,
      sawArgumentDelta: false,
    };
    calls.set(index, created);
    retainedToolCalls += 1;
    return created;
  };

  const appendIdentity = (
    current: string | undefined,
    fragment: unknown,
  ): string | undefined => {
    if (typeof fragment !== 'string') return current;
    return boundedToolValue(
      `${current ?? ''}${fragment}`,
      MAX_TOOL_IDENTITY_CHARS,
    );
  };

  const appendArguments = (call: PendingToolCall, fragment: unknown) => {
    if (typeof fragment !== 'string' || fragment.length === 0) return;
    call.sawArgumentDelta = true;
    if (call.argumentCapped) return;
    const available =
      MAX_AGGREGATE_TOOL_ARGUMENT_CHARS - retainedToolArgumentChars;
    if (available <= 0) {
      call.argumentCapped = true;
      return;
    }
    if (fragment.length <= available) {
      call.argumentText += fragment;
      retainedToolArgumentChars += fragment.length;
      return;
    }
    const suffix = TRUNCATED_SUFFIX.slice(0, available);
    const contentLength = Math.max(0, available - suffix.length);
    call.argumentText += `${fragment.slice(0, contentLength)}${suffix}`;
    retainedToolArgumentChars += available;
    call.argumentCapped = true;
  };

  const completedToolCall = (
    call: PendingToolCall,
    choice?: OpenAiChoiceState,
  ): SseToolCall => {
    const parsedArguments = call.sawArgumentDelta
      ? call.argumentCapped && !call.argumentText
        ? { truncated: true }
        : structuredArguments(call.argumentText)
      : call.initialArguments;
    const args = captureContent ? parsedArguments : undefined;
    const mcpServer =
      parsedArguments &&
      typeof parsedArguments === 'object' &&
      typeof (parsedArguments as Record<string, unknown>).serverName ===
        'string'
        ? ((parsedArguments as Record<string, unknown>).serverName as string)
        : undefined;
    return {
      ...(call.id ? { id: call.id } : {}),
      ...(call.name ? { name: call.name } : {}),
      ...(args !== undefined ? { arguments: args } : {}),
      ...(mcpServer ? { mcpServer } : {}),
      ...(!captureContent && isDelegationTool(call.name)
        ? { correlationArguments: parsedArguments }
        : {}),
      ...(choice
        ? {
            choiceIndex: choice.index,
            complete: choice.finishReason === 'tool_calls',
          }
        : {}),
    };
  };

  const sortedOpenAiChoices = (): OpenAiChoiceState[] =>
    [...openAiChoices.values()].sort((left, right) => left.index - right.index);

  const completedToolCalls = (): SseToolCall[] =>
    kind === 'openai'
      ? sortedOpenAiChoices().flatMap((choice) =>
          [...choice.pendingToolCalls.values()]
            .sort((left, right) => left.order - right.order)
            .map((call) => completedToolCall(call, choice)),
        )
      : [...pendingToolCalls.values()]
          .sort((left, right) => left.order - right.order)
          .map((call) => completedToolCall(call));

  const anthropicAssistantMessage = (
    toolCalls: SseToolCall[],
  ): SseAssistantMessage | undefined => {
    if (!captureContent) return undefined;
    if (toolCalls.length === 0) return undefined;
    const blocks = [
      ...[...anthropicTextBlocks.entries()].map(([order, text]) => ({
        order,
        block: { type: 'text', text },
      })),
      ...[...pendingToolCalls.values()].map((call) => {
        const completed = completedToolCall(call);
        return {
          order: call.order,
          block: {
            type: 'tool_use',
            ...(call.id ? { id: call.id } : {}),
            ...(call.name ? { name: call.name } : {}),
            ...(completed.arguments !== undefined
              ? { input: completed.arguments }
              : {}),
          },
        };
      }),
    ]
      .sort((left, right) => left.order - right.order)
      .map(({ block }) => block);
    return blocks.length > 0
      ? {
          role: 'assistant',
          content: blocks,
          ...(finishReason ? { finish_reason: finishReason } : {}),
        }
      : undefined;
  };

  const openAiAssistantMessage = (
    choice: OpenAiChoiceState,
  ): SseAssistantMessage | undefined => {
    if (!captureContent) return undefined;
    const toolCalls = [...choice.pendingToolCalls.values()]
      .sort((left, right) => left.order - right.order)
      .map((call) => completedToolCall(call, choice));
    if (
      !choice.completionText &&
      toolCalls.length === 0 &&
      !choice.refusalText
    ) {
      return undefined;
    }
    return {
      role: 'assistant',
      content: choice.completionText || null,
      index: choice.index,
      ...(choice.finishReason ? { finish_reason: choice.finishReason } : {}),
      ...(choice.refusalText ? { refusal: choice.refusalText } : {}),
      ...(toolCalls.length > 0 || choice.refusalText
        ? {
            tool_calls: toolCalls.map((call) => ({
              ...(call.id ? { id: call.id } : {}),
              type: 'function' as const,
              function: {
                ...(call.name ? { name: call.name } : {}),
                ...(call.arguments !== undefined
                  ? { arguments: call.arguments }
                  : {}),
              },
            })),
          }
        : {}),
    };
  };

  // Only recognized usage fields are retained — merging arbitrary provider
  // objects would let a long stream grow host memory without bound.
  const USAGE_KEYS = new Set([
    'input_tokens',
    'output_tokens',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    // Flat cache fields declared by providers in the model registry
    // (e.g. DeepSeek prompt_cache_hit/miss, Together cached_tokens).
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
    'cached_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
  ]);
  const mergeUsage = (value: unknown) => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (!USAGE_KEYS.has(key) || entry === undefined || entry === null) {
        continue;
      }
      if (typeof entry === 'number') {
        usage[key] = entry;
        sawUsage = true;
      } else if (typeof entry === 'object' && !Array.isArray(entry)) {
        const numeric: Record<string, number> = {};
        for (const [sub, subValue] of Object.entries(
          entry as Record<string, unknown>,
        ).slice(0, 8)) {
          if (typeof subValue === 'number') numeric[sub] = subValue;
        }
        if (Object.keys(numeric).length > 0) {
          usage[key] = numeric;
          sawUsage = true;
        }
      }
    }
  };

  const handleAnthropicEvent = (event: Record<string, unknown>) => {
    if (event.type === 'error') {
      captureError(event.error);
      return;
    }
    if (event.type === 'message_start') {
      const message = event.message as
        | { model?: string; usage?: unknown }
        | undefined;
      if (typeof message?.model === 'string') model = message.model;
      mergeUsage(message?.usage);
      return;
    }
    if (event.type === 'content_block_start') {
      const index = toolIndex(event.index, pendingToolCalls.size);
      const block = event.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'text') {
        const captured =
          typeof block.text === 'string' ? appendText(block.text) : '';
        if (captured && anthropicTextBlocks.size < MAX_TOOL_CALLS) {
          anthropicTextBlocks.set(index, captured);
        }
      } else if (block?.type === 'tool_use') {
        const call = getToolCall(pendingToolCalls, index);
        if (call) {
          call.id = appendIdentity(undefined, block.id);
          call.name = appendIdentity(undefined, block.name);
          call.initialArguments = initialArguments(block.input);
        }
      }
      return;
    }
    if (event.type === 'content_block_delta') {
      const index = toolIndex(event.index, pendingToolCalls.size);
      const delta = event.delta as
        | { type?: string; text?: string; partial_json?: string }
        | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        const captured = appendText(delta.text);
        if (
          captured &&
          (anthropicTextBlocks.has(index) ||
            anthropicTextBlocks.size < MAX_TOOL_CALLS)
        ) {
          const text = `${anthropicTextBlocks.get(index) ?? ''}${captured}`;
          anthropicTextBlocks.set(index, text);
        }
      } else if (delta?.type === 'input_json_delta') {
        const call = getToolCall(pendingToolCalls, index);
        if (call) appendArguments(call, delta.partial_json);
      }
      return;
    }
    if (event.type === 'message_delta') {
      mergeUsage(event.usage);
      const delta = event.delta as { stop_reason?: string } | undefined;
      if (typeof delta?.stop_reason === 'string') {
        finishReason = delta.stop_reason;
        if (finishReason === 'tool_use') toolCallsReady = true;
      }
    }
  };

  const handleOpenAiEvent = (event: Record<string, unknown>) => {
    if (event.error !== undefined && event.error !== null) {
      captureError(event.error);
    }
    if (typeof event.model === 'string') model = event.model;
    mergeUsage(event.usage);
    const choices = Array.isArray(event.choices)
      ? (event.choices as unknown[]).slice(0, MAX_TOOL_CALLS)
      : [];
    for (const [position, value] of choices.entries()) {
      if (value === null || typeof value !== 'object') continue;
      const choice = value as Record<string, unknown>;
      const index = toolIndex(choice.index, position);
      let choiceState = openAiChoices.get(index);
      if (!choiceState) {
        if (openAiChoices.size >= MAX_OPENAI_CHOICES) continue;
        choiceState = {
          index,
          completionText: '',
          completionCapped: false,
          refusalText: '',
          pendingToolCalls: new Map(),
        };
        openAiChoices.set(index, choiceState);
      }
      const delta = choice.delta as
        | { content?: unknown; refusal?: unknown; tool_calls?: unknown }
        | undefined;
      if (typeof delta?.content === 'string') {
        appendChoiceText(choiceState, delta.content);
      }
      if (typeof delta?.refusal === 'string') {
        appendChoiceRefusal(choiceState, delta.refusal);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const [toolPosition, toolValue] of delta.tool_calls.entries()) {
          if (toolValue === null || typeof toolValue !== 'object') continue;
          const fragment = toolValue as Record<string, unknown>;
          const call = getToolCall(
            choiceState.pendingToolCalls,
            toolIndex(fragment.index, toolPosition),
          );
          if (!call) continue;
          call.id = appendIdentity(call.id, fragment.id);
          const fn = fragment.function as Record<string, unknown> | undefined;
          call.name = appendIdentity(call.name, fn?.name);
          appendArguments(call, fn?.arguments);
        }
      }
      if (typeof choice.finish_reason === 'string') {
        choiceState.finishReason = choice.finish_reason;
        if (choiceState.finishReason === 'tool_calls') toolCallsReady = true;
      }
    }
  };

  const pushFrame = (frame: string) => {
    if (dead || done) return;
    if (frame.length > MAX_PENDING_CHARS) {
      // Never JSON.parse a provider-controlled multi-megabyte frame.
      dead = true;
      return;
    }
    try {
      const data = sseFrameData(frame);
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      const event = JSON.parse(data) as Record<string, unknown>;
      if (kind === 'anthropic') handleAnthropicEvent(event);
      else handleOpenAiEvent(event);
    } catch {
      // ponytail: one malformed frame stops parsing entirely; the proxied
      // stream is untouched and the span just carries partial data.
      dead = true;
    }
  };

  return {
    push: (chunk) => {
      if (dead || done) return;
      try {
        for (const frame of splitter.push(chunk)) pushFrame(frame);
        if (splitter.overflowed()) dead = true;
      } catch {
        dead = true;
      }
    },
    pushFrame,
    takeToolCallsReady: () => {
      const ready = toolCallsReady;
      toolCallsReady = false;
      return ready;
    },
    result: () => {
      const toolCalls = completedToolCalls();
      if (kind === 'openai') {
        const choices = sortedOpenAiChoices();
        const messages = choices.flatMap((choice) => {
          const message = openAiAssistantMessage(choice);
          return message ? [message] : [];
        });
        const finishReasons = choices.flatMap((choice) =>
          choice.finishReason ? [choice.finishReason] : [],
        );
        const onlyChoice = choices.length === 1 ? choices[0] : undefined;
        const onlyMessage = messages.length === 1 ? messages[0] : undefined;
        return {
          ...(model ? { model } : {}),
          ...(sawUsage ? { usage } : {}),
          ...(onlyChoice?.completionText
            ? { completionText: onlyChoice.completionText }
            : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          ...(onlyMessage &&
          (onlyChoice?.pendingToolCalls.size || onlyChoice?.refusalText)
            ? { assistantMessage: onlyMessage }
            : {}),
          ...(choices.length > 1 && messages.length > 0
            ? { assistantMessages: messages }
            : {}),
          ...(onlyChoice?.finishReason
            ? { finishReason: onlyChoice.finishReason }
            : {}),
          ...(choices.length > 1 && finishReasons.length > 0
            ? { finishReasons }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        };
      }
      const message = anthropicAssistantMessage(toolCalls);
      return {
        ...(model ? { model } : {}),
        ...(sawUsage ? { usage } : {}),
        ...(completionText ? { completionText } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(message ? { assistantMessage: message } : {}),
        ...(finishReason ? { finishReason } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      };
    },
  };
}
