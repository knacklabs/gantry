import type { AgentEngine } from '../shared/agent-engine.js';
import {
  formatInlineAgentWorkerOnlyConfigError,
  inlineWorkerOnlyToolRuleLabels,
  type AgentRuntime,
} from '../shared/agent-runtime.js';
import { parseSemanticCapabilityRule } from '../shared/semantic-capability-ids.js';
import type { RunnerSandboxProviderId } from '../shared/runner-sandbox-provider.js';
import {
  fixedImageSetupRequiredMessage,
  missingImageCapabilities,
  readImageCapabilityInventory,
} from '../shared/worker-image-inventory.js';
import type { AgentInput } from './agent-spawn-types.js';
import { validateRunnerAllowedTools } from './agent-spawn-runtime-policy.js';
import { deepAgentsShellFilesystemGuard } from './deepagents-shell-filesystem-guard.js';

export function validateAgentPreSpawnAdmission(input: {
  agentInput: AgentInput;
  agentEngine: AgentEngine;
  agentRuntime?: AgentRuntime;
  stdioMcpSourceIds?: readonly string[];
  sandboxProvider: RunnerSandboxProviderId | undefined;
  securityEnv: NodeJS.ProcessEnv;
}): string | null {
  const inlineAdmissionError = inlineRuntimePreSpawnAdmissionError(input);
  if (inlineAdmissionError) return inlineAdmissionError;
  return (
    validateRunnerAllowedTools(
      input.agentInput.toolPolicyRules ?? [],
      input.agentInput.runtimeAccess ?? [],
    ) ??
    deepAgentsShellFilesystemGuard({
      engine: input.agentEngine,
      toolPolicyRules: input.agentInput.toolPolicyRules,
      securityEnv: input.securityEnv,
      sandboxProvider: input.sandboxProvider,
    }) ??
    fixedImageCapabilityPreflightError(input.agentInput)
  );
}

function inlineRuntimePreSpawnAdmissionError(input: {
  agentInput: AgentInput;
  agentRuntime?: AgentRuntime;
  stdioMcpSourceIds?: readonly string[];
}): string | null {
  const runtime = input.agentRuntime ?? input.agentInput.runtime ?? 'worker';
  if (runtime !== 'inline') return null;
  const labels = new Set<string>();
  for (const skill of input.agentInput.attachedSkillSourceIds ?? []) {
    labels.add(skill);
  }
  for (const rule of inlineWorkerOnlyToolRuleLabels(
    input.agentInput.toolPolicyRules ?? [],
  )) {
    labels.add(rule);
  }
  const stdioMcpSourceIds = new Set(input.stdioMcpSourceIds ?? []);
  for (const source of input.agentInput.attachedMcpSourceIds ?? []) {
    if (stdioMcpSourceIds.has(source)) labels.add(source);
  }
  for (const access of input.agentInput.runtimeAccess ?? []) {
    if (
      access.sourceType === 'local_cli' ||
      access.sourceType === 'skill_action'
    ) {
      labels.add(access.selectedCapabilityId);
      continue;
    }
    if (access.sourceType === 'mcp_server') {
      if (stdioMcpSourceIds.has(access.reviewedServerId)) {
        labels.add(access.selectedCapabilityId);
      }
      continue;
    }
    if (access.sourceType === 'builtin_tool') {
      if (inlineWorkerOnlyToolRuleLabels(access.runtimeToolRules).length > 0) {
        labels.add(access.selectedCapabilityId);
      }
    }
  }
  return labels.size === 0
    ? null
    : formatInlineAgentWorkerOnlyConfigError('agent', [...labels].sort());
}

function fixedImageCapabilityPreflightError(input: AgentInput): string | null {
  const imageInventory = readImageCapabilityInventory();
  if (!imageInventory) return null;
  const selectedSemanticCapabilityIds = new Set(
    (input.toolPolicyRules ?? [])
      .map((rule) => parseSemanticCapabilityRule(rule))
      .filter((id): id is string => Boolean(id)),
  );
  const missing = missingImageCapabilities(
    [...selectedSemanticCapabilityIds].map((capabilityId) => ({
      capabilityId,
    })),
    imageInventory,
  );
  return missing.length === 0 ? null : fixedImageSetupRequiredMessage(missing);
}
