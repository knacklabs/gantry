import { StringDecoder } from 'node:string_decoder';

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
export const MAX_PENDING_CHARS = 1_048_576;

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
