import {
  redactSensitiveText,
  sanitizeOutboundLlmText,
} from '../shared/sensitive-material.js';

const PERMISSION_MESSAGE_BUDGET = 2800;

export function headTailTruncate(
  input: string,
  head: number,
  tail: number,
): string {
  if (input.length <= head + tail + 1) return input;
  return `${input.slice(0, head)}…${input.slice(-tail)}`;
}

export function sanitizePermissionText(
  input: string,
  head: number,
  tail: number,
): string {
  const result = sanitizeOutboundLlmText(input);
  if (result.blocked) {
    return 'Sensitive detail hidden.';
  }
  return headTailTruncate(result.text, head, tail);
}

export function sanitizePermissionCommandText(
  input: string,
  head: number,
  tail: number,
): string {
  return clampCommandForDisplay(redactSensitiveText(input), head, tail);
}

export function limitPermissionMessage(
  input: string,
  budget = PERMISSION_MESSAGE_BUDGET,
): string {
  if (input.length <= budget) return input;
  return `${input.slice(0, budget - 44)}\n\n[additional permission details omitted]`;
}

export function sanitizeReceiptDetail(input: string): string | null {
  const result = sanitizeOutboundLlmText(input);
  // Only drop the whole detail when a secret couldn't be safely span-masked.
  // When a real secret was span-redacted, show the command with just the span
  // masked (result.text is the span-redacted text) rather than hiding it all.
  if (result.blocked) return null;
  return headTailTruncate(result.text, 200, 100);
}

function clampCommandForDisplay(
  input: string,
  head: number,
  tail: number,
): string {
  const budget = head + tail;
  if (input.length <= budget + 1) return input;
  const lines = input.split(/\r?\n/);
  if (lines.length <= 1 || lines[0].length > budget) {
    return headTailTruncate(input, head, tail);
  }
  const shown: string[] = [];
  let used = 0;
  for (const line of lines) {
    const nextUsed = used + (shown.length > 0 ? 1 : 0) + line.length;
    if (shown.length > 0 && nextUsed > budget) break;
    shown.push(line);
    used = nextUsed;
    if (used >= budget) break;
  }
  const hidden = lines.length - shown.length;
  if (hidden <= 0) return input;
  return `${shown.join('\n')}\n… (+${hidden} more lines)`;
}
