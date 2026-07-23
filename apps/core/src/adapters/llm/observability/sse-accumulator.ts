import { StringDecoder } from 'node:string_decoder';

export type SseStreamKind = 'anthropic' | 'openai';

const MAX_COMPLETION_CHARS = 256 * 1024;

export interface SseAccumulatorResult {
  model?: string;
  usage?: Record<string, unknown>;
  completionText?: string;
  finishReason?: string;
  // Providers can fail mid-stream behind an HTTP 200 (top-level `error`
  // chunk / `error` event); spans must not export those as successes.
  errorMessage?: string;
}

export interface SseFrameSplitter {
  push: (chunk: Buffer) => string[];
  flush: () => string[];
  // True once a single unterminated frame exceeds the pending cap; parsing
  // stops and takePending() releases the buffered text exactly once.
  overflowed: () => boolean;
  takePending: () => string;
}

// A hostile or broken provider can stream one giant frame with no blank-line
// delimiter; pending state is capped so observability never retains
// unbounded provider-controlled bytes.
const MAX_PENDING_CHARS = 1_048_576;

// SSE frames are separated by a blank line; tolerate CRLF. StringDecoder
// holds partial multibyte UTF-8 sequences split across chunk boundaries —
// plain chunk.toString('utf8') would corrupt them.
export function createSseFrameSplitter(): SseFrameSplitter {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  // Where delimiter scanning resumes — re-scanning `pending` from zero on
  // every push is quadratic when one large frame arrives in many chunks.
  let scanFrom = 0;
  let overflowed = false;
  return {
    push: (chunk) => {
      if (overflowed) return [];
      pending += decoder.write(chunk);
      const frames: string[] = [];
      // SSE line terminators: CRLF, LF, or CR (spec-legal, CR-only rare).
      const delimiter = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r|\n)/g;
      delimiter.lastIndex = scanFrom;
      let consumed = 0;
      let match: RegExpExecArray | null;
      while ((match = delimiter.exec(pending))) {
        const frame = pending.slice(consumed, match.index);
        // A COMPLETE oversized frame must trip the cap too — the bytes are
        // still returned (the tap forwards them) but parsing stops.
        if (frame.length > MAX_PENDING_CHARS) overflowed = true;
        frames.push(frame);
        consumed = match.index + match[0].length;
        delimiter.lastIndex = consumed;
      }
      if (consumed > 0) pending = pending.slice(consumed);
      // Overlap of 3 covers a CRLFCRLF delimiter split across chunks.
      scanFrom = Math.max(0, pending.length - 3);
      if (pending.length > MAX_PENDING_CHARS) overflowed = true;
      return frames;
    },
    flush: () => {
      if (overflowed) return [];
      const rest = pending + decoder.end();
      pending = '';
      scanFrom = 0;
      return rest.trim() ? [rest] : [];
    },
    overflowed: () => overflowed,
    takePending: () => {
      // Include the decoder flush so carry bytes of a split codepoint are
      // emitted (as U+FFFD) rather than silently dropped; the byte-exact
      // raw-buffer fallback remains the named revisit for this edge.
      const rest = pending + decoder.end();
      pending = '';
      scanFrom = 0;
      return rest;
    },
  };
}

export function sseFrameData(frame: string): string | undefined {
  const dataLines = frame
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
  if (dataLines.length === 0) return undefined;
  return dataLines.join('\n');
}

// An OpenAI stream_options.include_usage terminal chunk: usage present and
// no choices content. Used to strip the frame when the gateway injected the
// flag on behalf of a caller that did not ask for it.
export function isOpenAiUsageOnlyFrame(frame: string): boolean {
  // Oversized frames are never parsed (and are not usage-only chunks).
  if (frame.length > MAX_PENDING_CHARS) return false;
  const data = sseFrameData(frame);
  if (!data || data === '[DONE]') return false;
  try {
    const parsed = JSON.parse(data) as {
      usage?: unknown;
      choices?: unknown[];
    };
    return (
      parsed.usage !== undefined &&
      parsed.usage !== null &&
      (!Array.isArray(parsed.choices) || parsed.choices.length === 0)
    );
  } catch {
    return false;
  }
}

export interface SseAccumulator {
  push: (chunk: Buffer) => void;
  pushFrame: (frame: string) => void;
  result: () => SseAccumulatorResult;
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

  const captureError = (value: unknown) => {
    if (errorMessage || value === null || typeof value !== 'object') return;
    const err = value as { message?: unknown; type?: unknown; code?: unknown };
    const parts = [err.type ?? err.code, err.message]
      .filter((part) => typeof part === 'string' || typeof part === 'number')
      .map(String);
    errorMessage = parts.length > 0 ? parts.join(': ') : 'stream error';
  };

  const appendText = (text: string) => {
    if (!captureContent || completionCapped) return;
    completionText += text;
    if (completionText.length > MAX_COMPLETION_CHARS) {
      completionText = completionText.slice(0, MAX_COMPLETION_CHARS);
      completionCapped = true;
    }
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
        { model?: string; usage?: unknown } | undefined;
      if (typeof message?.model === 'string') model = message.model;
      mergeUsage(message?.usage);
      return;
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        appendText(delta.text);
      }
      return;
    }
    if (event.type === 'message_delta') {
      mergeUsage(event.usage);
      const delta = event.delta as { stop_reason?: string } | undefined;
      if (typeof delta?.stop_reason === 'string') {
        finishReason = delta.stop_reason;
      }
    }
  };

  const handleOpenAiEvent = (event: Record<string, unknown>) => {
    if (event.error !== undefined && event.error !== null) {
      captureError(event.error);
    }
    if (typeof event.model === 'string') model = event.model;
    mergeUsage(event.usage);
    const choice = (
      event.choices as Record<string, unknown>[] | undefined
    )?.[0];
    if (!choice) return;
    const delta = choice.delta as { content?: unknown } | undefined;
    if (typeof delta?.content === 'string') appendText(delta.content);
    if (typeof choice.finish_reason === 'string') {
      finishReason = choice.finish_reason;
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
    result: () => ({
      ...(model ? { model } : {}),
      ...(sawUsage ? { usage } : {}),
      ...(completionText ? { completionText } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    }),
  };
}
