import type {
  HookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import {
  evaluateProtectedCapabilityToolUse as evaluateCanonicalProtectedCapabilityToolUse,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../../../../shared/tool-execution-policy-service.js';
import { denyMemoryBoundaryToolUse } from '../../../../shared/memory-boundary.js';
import { applyBashTrustEnv } from './bash-trust-env.js';
import type { SemanticCapabilityDefinition } from '../../../../shared/semantic-capabilities.js';
import { semanticCapabilityRuntimeRules } from '../../../../shared/semantic-capabilities.js';
import { semanticCapabilityRule } from '../../../../shared/semantic-capability-ids.js';
import { readRunnerSkillActionCapabilities } from './permission-suggestions.js';

const BLOCK_MESSAGE =
  'Gantry blocks direct edits to agent capability configuration. Request the missing action or source setup through the Gantry access flow so the change is reviewed, stored durably, and activated through approved access.';

export interface ProtectedCapabilityDecision {
  reason: string;
  recoveryAction?: string;
}

export function attributedSkillActionRules(
  liveRules: readonly string[],
  skillActionCapabilities: readonly SemanticCapabilityDefinition[],
): string[] {
  const liveRuleSet = new Set(liveRules);
  const selectedSkillAliases = skillActionCapabilities.flatMap((capability) => {
    const source = capability.source;
    const runtimeRules = semanticCapabilityRuntimeRules(capability);
    return source &&
      typeof source === 'object' &&
      !Array.isArray(source) &&
      (source as Record<string, unknown>).kind === 'skill_action' &&
      runtimeRules.length > 0 &&
      runtimeRules.every((rule) => liveRuleSet.has(rule))
      ? [semanticCapabilityRule(capability.capabilityId)]
      : [];
  });
  // The alias adds attribution, not authority: it is projected only when every
  // concrete rule in the reviewed skill action is already present in the
  // host-projected rule set for this exact run.
  return [...selectedSkillAliases, ...liveRules];
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
  selectedAccess: {
    isScheduledJob?: boolean;
    jobId?: string;
    allowedToolRules?: readonly string[];
    selectedCapabilityIds?: readonly string[];
    /** Preflight-only declarations; never used to mint runtime authority. */
    toolAccessRequirements?: readonly string[];
    semanticCapabilities?: readonly SemanticCapabilityDefinition[];
  } = {},
): (input: HookInput) => Promise<SyncHookJSONOutput> {
  return (input) =>
    safetyPreToolUseHook(input, memoryBlock, toolNetworkEnv, selectedAccess);
}

async function safetyPreToolUseHook(
  input: HookInput,
  memoryBlock: string,
  toolNetworkEnv: Record<string, string | undefined> = {},
  selectedAccess: {
    isScheduledJob?: boolean;
    jobId?: string;
    allowedToolRules?: readonly string[];
    selectedCapabilityIds?: readonly string[];
    /** Preflight-only declarations; never used to mint runtime authority. */
    toolAccessRequirements?: readonly string[];
    semanticCapabilities?: readonly SemanticCapabilityDefinition[];
  } = {},
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
    executionMode: selectedAccess.isScheduledJob ? 'autonomous' : 'interactive',
    runContext: selectedAccess.jobId
      ? { jobId: selectedAccess.jobId }
      : undefined,
  });
  const semanticCapabilities = [
    ...(selectedAccess.semanticCapabilities ?? []),
    ...readRunnerSkillActionCapabilities(),
  ];
  const semanticCapabilityDefinitions = Object.fromEntries(
    semanticCapabilities.map((capability) => [
      capability.capabilityId,
      capability,
    ]),
  );
  const selectedCapabilityRules = [
    // Resolve selected semantic aliases first. Runtime policy projection also
    // includes their concrete rules; putting those first would de-duplicate
    // the later alias expansion before it can retain capability attribution.
    ...new Set(selectedAccess.selectedCapabilityIds ?? []),
  ].map(semanticCapabilityRule);
  const selectedToolRules = [
    ...selectedCapabilityRules,
    ...attributedSkillActionRules(
      selectedAccess.allowedToolRules ?? [],
      semanticCapabilities,
    ),
  ];
  const decision = new ToolExecutionPolicyService().evaluate({
    request,
    ...(selectedAccess.isScheduledJob
      ? {
          autonomousAllowedToolRules: selectedToolRules,
        }
      : { allowedToolRules: selectedToolRules }),
    semanticCapabilityDefinitions,
  });
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
