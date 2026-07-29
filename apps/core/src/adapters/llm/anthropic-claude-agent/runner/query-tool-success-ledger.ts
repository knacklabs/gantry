import type { PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import type { RunScopedToolSuccessLedger } from '../../../../runner/tool-gate-core.js';
import { canonicalGantryToolRuleName } from '../../../../shared/gantry-tool-facades.js';

export function toolResponseIsError(response: unknown): boolean {
  if (Array.isArray(response)) return response.some(toolResponseIsError);
  if (!response || typeof response !== 'object') return false;
  const value = response as {
    is_error?: unknown;
    isError?: unknown;
    status?: unknown;
    error?: unknown;
    content?: unknown;
  };
  return (
    value.is_error === true ||
    value.isError === true ||
    value.status === 'error' ||
    Boolean(value.error) ||
    toolResponseIsError(value.content)
  );
}

export function recordSuccessfulToolUse(
  hookInput: Pick<PostToolUseHookInput, 'tool_name' | 'tool_response'>,
  toolSuccessLedger: RunScopedToolSuccessLedger,
): void {
  if (toolResponseIsError(hookInput.tool_response)) return;
  toolSuccessLedger.recordSuccess(
    canonicalGantryToolRuleName(hookInput.tool_name),
  );
}
