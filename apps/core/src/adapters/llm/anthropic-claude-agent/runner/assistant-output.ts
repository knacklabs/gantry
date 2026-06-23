/**
 * Pure helpers for reading an SDK assistant message's visible text and deciding
 * what to surface as an early progress message. Kept dependency-free (no
 * runtime/env imports) so they are unit-testable without booting the runner.
 */

/** Concatenated text of an assistant message (the turn's visible output). */
export function assistantOutputText(message: unknown): string {
  const candidates = [
    (message as { content?: unknown }).content,
    (message as { message?: { content?: unknown } }).message?.content,
  ];
  const parts: string[] = [];
  for (const content of candidates) {
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        parts.push((block as { text: string }).text);
      }
    }
  }
  return parts.join('');
}

/**
 * Picks the preamble text to surface as an early progress message for a turn
 * that ends in a tool call. The SDK may deliver a turn's text and its tool_use
 * either combined in one assistant message or split across two (a text-only
 * message, then a tool_use-only message whose own text is empty). When this
 * tool_use message carries no text of its own, fall back to the text
 * accumulated from the streamed deltas — otherwise the preamble is dropped from
 * the early-send path and only surfaces (late) via the end-of-run turn list.
 */
export function selectToolUsePreamble(
  ownText: string,
  streamedText: string,
): string {
  return ownText.trim() ? ownText : streamedText;
}
