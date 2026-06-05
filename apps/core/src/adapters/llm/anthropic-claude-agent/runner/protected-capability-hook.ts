import type {
  HookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import {
  evaluateProtectedCapabilityToolUse as evaluateCanonicalProtectedCapabilityToolUse,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../../../shared/tool-execution-policy-service.js';
import { denyMemoryBoundaryToolUse } from '../../../../runner/memory-boundary.js';
import { applyBashTrustEnv } from './bash-trust-env.js';

const BLOCK_MESSAGE =
  'Gantry blocks direct edits to agent capability configuration. Request the missing action or source setup through the Gantry access flow so the change is reviewed, stored durably, and activated through approved access.';

export interface ProtectedCapabilityDecision {
  reason: string;
  recoveryAction?: string;
}

export function evaluateProtectedCapabilityToolUse(
  toolName: string,
  input: unknown,
): ProtectedCapabilityDecision | null {
  return evaluateCanonicalProtectedCapabilityToolUse(toolName, input);
}

export async function protectedCapabilityPreToolUseHook(
  input: HookInput,
): Promise<SyncHookJSONOutput> {
  return safetyPreToolUseHook(input, '');
}

export function createSafetyPreToolUseHook(
  memoryBlock: string,
  toolNetworkEnv: Record<string, string | undefined> = {},
): (input: HookInput) => Promise<SyncHookJSONOutput> {
  return (input) => safetyPreToolUseHook(input, memoryBlock, toolNetworkEnv);
}

async function safetyPreToolUseHook(
  input: HookInput,
  memoryBlock: string,
  toolNetworkEnv: Record<string, string | undefined> = {},
): Promise<SyncHookJSONOutput> {
  if (input.hook_event_name !== 'PreToolUse') {
    return { continue: true };
  }

  const memoryDenial = denyMemoryBoundaryToolUse(
    input.tool_name,
    input.tool_input,
    {},
    memoryBlock,
  );
  if (memoryDenial) {
    return denyPreToolUse(memoryDenial);
  }

  const request = new ToolExecutionClassifier().classify({
    origin: 'sdk',
    toolName: input.tool_name,
    toolInput: input.tool_input,
  });
  const decision = new ToolExecutionPolicyService().evaluate({ request });
  if (decision.status !== 'deny') {
    return allowPreToolUseWithTrustEnv(
      input.tool_name,
      input.tool_input,
      toolNetworkEnv,
    );
  }

  const reason = `${decision.reason} ${decision.recoveryAction ?? BLOCK_MESSAGE}`;
  return denyPreToolUse(reason);
}

function allowPreToolUseWithTrustEnv(
  toolName: string,
  toolInput: unknown,
  toolNetworkEnv: Record<string, string | undefined>,
): SyncHookJSONOutput {
  if (!toolInput || typeof toolInput !== 'object') {
    return { continue: true };
  }
  const updatedInput = applyBashTrustEnv(
    toolName,
    toolInput as Record<string, unknown>,
    toolNetworkEnv,
  );
  if (updatedInput === toolInput) {
    return { continue: true };
  }
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
    },
  };
}

function denyPreToolUse(reason: string): SyncHookJSONOutput {
  return {
    continue: false,
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
