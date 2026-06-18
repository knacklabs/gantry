import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

// Gated prompt cache_control breakpoints for the DeepAgents lane.
//
// The HOST resolves the model's prompt-cache request control from the catalog
// (resolveModelCacheSupport(entry).prompt.requestControl) and projects it as a
// mode the runner applies WITHOUT importing the catalog (provider boundary):
//   - 'automatic' (OpenAI gpt, OpenRouter Kimi): the upstream caches the request
//     prefix automatically — inject NOTHING.
//   - 'none': the model has no prompt cache — inject NOTHING.
//   - 'explicit' (OpenRouter Anthropic/Gemini/Qwen sub-models; none shipped
//     today): the upstream needs OpenAI-style `cache_control:{type:'ephemeral'}`
//     breakpoints on the stable prompt prefix content parts.
//
// On 'explicit', cache_control is applied to the leading STABLE prefix messages
// — the durable-memory-context block and the first turn message — by converting
// their string content to a single text content part carrying cache_control.
// The breakpoint count is capped at MAX_CACHE_CONTROL_BREAKPOINTS (4), the
// OpenAI/Anthropic-compatible per-request limit.
export type CachePromptControlMode = 'automatic' | 'explicit' | 'none';

export const MAX_CACHE_CONTROL_BREAKPOINTS = 4;

const CACHE_CONTROL_EPHEMERAL = { type: 'ephemeral' as const };

export function parseCachePromptControlMode(
  value: string | undefined,
): CachePromptControlMode {
  const mode = value?.trim().toLowerCase();
  if (mode === 'explicit' || mode === 'automatic' || mode === 'none') {
    return mode;
  }
  // Fail safe: anything unrecognized injects nothing (no spurious breakpoints).
  return 'none';
}

// Pure transform over the turn messages. Returns the SAME array reference when
// the mode injects nothing (automatic/none), or a new array with cache_control
// breakpoints on the leading stable prefix messages when 'explicit'.
export function applyCachePromptControl(
  messages: BaseMessage[],
  mode: CachePromptControlMode,
): BaseMessage[] {
  if (mode !== 'explicit') return messages;
  if (messages.length === 0) return messages;

  // Breakpoint the leading stable prefix: the durable-memory-context block (the
  // last leading HumanMessage carrying the <gantry_memory_context> framing) and
  // the first turn message. We mark from the front up to the cap.
  let remaining = MAX_CACHE_CONTROL_BREAKPOINTS;
  const next = messages.map((message, index) => {
    if (remaining <= 0) return message;
    // Breakpoint only the leading prefix messages (index 0 and any leading
    // memory-block HumanMessage at index 1) — the stable prompt prefix.
    if (index > 1) return message;
    remaining -= 1;
    return withCacheControlBreakpoint(message);
  });
  return next;
}

// Converts a message's content to a single text content part carrying
// cache_control. String content becomes `[{type:'text', text, cache_control}]`;
// an existing content-part array gets cache_control on its LAST text part (one
// breakpoint per message). Non-text / empty content is returned unchanged.
function withCacheControlBreakpoint(message: BaseMessage): BaseMessage {
  const content = message.content;
  if (typeof content === 'string') {
    if (content.length === 0) return message;
    return cloneWithContent(message, [
      { type: 'text', text: content, cache_control: CACHE_CONTROL_EPHEMERAL },
    ]);
  }
  if (Array.isArray(content)) {
    let marked = false;
    const parts: unknown[] = [...content];
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const part = parts[i];
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        parts[i] = {
          ...(part as Record<string, unknown>),
          cache_control: CACHE_CONTROL_EPHEMERAL,
        };
        marked = true;
        break;
      }
    }
    if (!marked) return message;
    return cloneWithContent(message, parts);
  }
  return message;
}

function cloneWithContent(
  message: BaseMessage,
  content: unknown[],
): BaseMessage {
  // Only HumanMessage prefixes are breakpointed in this lane; preserve the type.
  if (HumanMessage.isInstance(message)) {
    return new HumanMessage({
      content: content as never,
      additional_kwargs: message.additional_kwargs,
    });
  }
  return message;
}
