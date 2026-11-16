import {
  classifyProviderBillingFailure,
  type ProviderBillingFailure,
} from './provider-billing.js';

const MAX_ERROR_BYTES = 64 * 1024;

// Observe forwarded bytes without cloning/awaiting a potentially stalled error response.
export function createProviderBillingTap(
  provider: string,
  status: number,
  streaming: boolean,
  onFailure: (failure: ProviderBillingFailure) => void,
) {
  let pending = '';
  let oversized = false;
  let reported = false;
  const decoder = new TextDecoder();
  const inspect = (value: unknown) => {
    if (reported) return;
    const failure = classifyProviderBillingFailure(provider, {
      status,
      ...(value && typeof value === 'object' ? value : {}),
    });
    if (failure) {
      reported = true;
      onFailure(failure);
    }
  };
  const parse = (text: string) => {
    try {
      inspect(JSON.parse(text));
    } catch {
      /* Non-JSON output is never a billing signal. */
    }
  };
  const consume = (text: string) => {
    if (!streaming) {
      if (pending.length + text.length > MAX_ERROR_BYTES) {
        oversized = true;
        pending = '';
      } else if (!oversized) pending += text;
      return;
    }
    // Consume line by line even when one transport chunk contains many SSE frames.
    for (const part of text.split(/(?<=\n)/)) {
      if (pending.length + part.length > MAX_ERROR_BYTES) {
        oversized = true;
        pending = '';
      } else if (!oversized) pending += part;
      if (part.endsWith('\n')) {
        if (!oversized && pending.startsWith('data:'))
          parse(pending.slice(5).trim());
        oversized = false;
        pending = '';
      }
    }
  };
  return {
    transform(chunk: Buffer): Buffer {
      if (!reported) consume(decoder.decode(chunk, { stream: true }));
      return chunk;
    },
    flush(): Buffer {
      consume(decoder.decode());
      if (!streaming && !oversized) parse(pending);
      return Buffer.alloc(0);
    },
  };
}

// Only the configured failed Firecrawl tool result is authoritative; normal page text is ignored.
export function firecrawlBillingFailure(
  server: string,
  tool: string,
  result: unknown,
  credentialRef: string,
) {
  if (
    !['firecrawl', 'firecrawl-http'].includes(server) ||
    !tool.startsWith('firecrawl_') ||
    !result ||
    typeof result !== 'object'
  )
    return undefined;
  const envelope = result as Record<string, unknown>;
  if (envelope.isError !== true) return undefined;
  const candidates: unknown[] = [envelope.structuredContent, envelope];
  if (Array.isArray(envelope.content))
    for (const block of envelope.content.slice(0, 8)) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue;
      const text = block.text.slice(0, MAX_ERROR_BYTES);
      try {
        candidates.push(JSON.parse(text));
      } catch {
        candidates.push({ message: text });
      }
    }
  for (const candidate of candidates) {
    const failure = classifyProviderBillingFailure('firecrawl', candidate);
    if (failure) return { ...failure, credentialRef, operation: tool };
  }
  return undefined;
}
