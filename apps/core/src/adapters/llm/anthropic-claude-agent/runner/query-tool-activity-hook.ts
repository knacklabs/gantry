import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

import {
  privateToolActivityInvocationIdFromResult,
  type ToolActivityFamily,
} from '../../../../domain/events/tool-activity.js';
import type { RunScopedToolSuccessLedger } from '../../../../runner/tool-gate-core.js';
import type { createPermissionApprovalContextChannel } from './tool-permission-gate.js';
import {
  recordSuccessfulToolUse,
  toolResponseIsError,
} from './query-tool-success-ledger.js';
import {
  unprojectedAccessActivityDetail,
  unprojectedAccessIdentityFromToolResult,
} from '../../../../shared/unprojected-access.js';

export function createPostToolUseHook(input: {
  toolSuccessLedger?: RunScopedToolSuccessLedger;
  emitTerminalToolOutcome: (outcome: {
    invocationId: string;
    toolName: string;
    family?: ToolActivityFamily;
    outcome: 'success' | 'failure';
    detail?: string;
  }) => void;
  takeGantryOwnedToolActivityFamily?: (
    providerInvocationId: string,
  ) => ToolActivityFamily | undefined;
  postToolUse: ReturnType<
    typeof createPermissionApprovalContextChannel
  >['postToolUse'];
}) {
  return async (
    hookInput: HookInput,
    toolUseID: string | undefined,
    hookOptions: { signal: AbortSignal },
  ) => {
    const toolResponse =
      'tool_response' in hookInput ? hookInput.tool_response : undefined;
    if (
      hookInput.hook_event_name === 'PostToolUse' &&
      input.toolSuccessLedger
    ) {
      recordSuccessfulToolUse(hookInput, input.toolSuccessLedger);
    }
    if (
      hookInput.hook_event_name === 'PostToolUse' ||
      hookInput.hook_event_name === 'PostToolUseFailure'
    ) {
      const providerInvocationId =
        hookInput.tool_use_id?.trim() || toolUseID?.trim();
      const family = providerInvocationId
        ? input.takeGantryOwnedToolActivityFamily?.(providerInvocationId)
        : undefined;
      const invocationId =
        (family
          ? privateToolActivityInvocationIdFromResult(toolResponse)
          : undefined) ?? providerInvocationId;
      if (invocationId) {
        const unprojectedIdentity =
          family && isRequestAccessTool(hookInput.tool_name)
            ? unprojectedAccessIdentityFromToolResult(toolResponse)
            : undefined;
        input.emitTerminalToolOutcome({
          invocationId,
          toolName: hookInput.tool_name,
          ...(family ? { family } : {}),
          outcome:
            hookInput.hook_event_name === 'PostToolUseFailure' ||
            toolResponseIsError(toolResponse)
              ? 'failure'
              : 'success',
          ...(unprojectedIdentity
            ? {
                detail: unprojectedAccessActivityDetail(
                  unprojectedIdentity,
                ),
              }
            : {}),
        });
      }
    }
    return input.postToolUse(hookInput, toolUseID, hookOptions);
  };
}

function isRequestAccessTool(toolName: string): boolean {
  return (
    toolName === 'request_access' ||
    toolName === 'mcp__gantry__request_access'
  );
}
