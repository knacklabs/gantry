import {
  headTailTruncate,
  permissionPromptSafe,
  SENSITIVE_DETAIL_HIDDEN,
} from '../shared/permission-display-input.js';

export { headTailTruncate };

const PERMISSION_MESSAGE_BUDGET = 2800;

export function sanitizePermissionText(
  input: string,
  head: number,
  tail: number,
): string {
  return permissionPromptSafe(input, { head, tail });
}

export function sanitizePermissionCommandText(
  input: string,
  head: number,
  tail: number,
): string {
  return permissionPromptSafe(input, { head, tail, command: true });
}

export function limitPermissionMessage(
  input: string,
  budget = PERMISSION_MESSAGE_BUDGET,
): string {
  if (input.length <= budget) return input;
  return `${input.slice(0, budget - 44)}\n\n[additional permission details omitted]`;
}

/** A receipt drops the detail entirely only when a secret couldn't be
 *  span-masked; a masked secret still shows the rest of the command. */
export function sanitizeReceiptDetail(input: string): string | null {
  const text = permissionPromptSafe(input, { head: 200, tail: 100 });
  return text === SENSITIVE_DETAIL_HIDDEN ? null : text;
}
