import { DEEPAGENTS_ENGINE, type AgentEngine } from '../shared/agent-engine.js';
import {
  formatInlineAgentWorkerOnlyConfigError,
  inlineAgentSkillEngineConstraintError,
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
import type { ModelCatalogEntry } from '../shared/model-catalog.js';
import type { AgentInput } from './agent-spawn-types.js';
import { validateRunnerAllowedTools } from './agent-spawn-runtime-policy.js';
import { deepAgentsShellFilesystemGuard } from './deepagents-shell-filesystem-guard.js';

export function validateAgentPreSpawnAdmission(input: {
  agentInput: AgentInput;
  agentEngine: AgentEngine;
  agentRuntime?: AgentRuntime;
  modelEntry?: ModelCatalogEntry;
  stdioMcpSourceIds?: readonly string[];
  sandboxProvider: RunnerSandboxProviderId | undefined;
  securityEnv: NodeJS.ProcessEnv;
}): string | null {
  const inlineAdmissionError = inlineRuntimePreSpawnAdmissionError(input);
  if (inlineAdmissionError) return inlineAdmissionError;
  const controlError = agentControlAdmissionError(input);
  if (controlError) return controlError;
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

function agentControlAdmissionError(input: {
  agentInput: AgentInput;
  agentEngine: AgentEngine;
  modelEntry?: ModelCatalogEntry;
}): string | null {
  const { agentInput, modelEntry } = input;
  if (!modelEntry) return null;
  const model = agentInput.model ?? modelEntry.recommendedAlias;
  const deepAgents = input.agentEngine === DEEPAGENTS_ENGINE;
  if (agentInput.effort !== undefined) {
    if (
      !(deepAgents
        ? modelEntry.supportsReasoningEffort
        : modelEntry.supportsEffort)
    ) {
      return `effort is not supported by model ${model}.`;
    }
    if (
      modelEntry.supportedEffortLevels.length > 0 &&
      !modelEntry.supportedEffortLevels.includes(agentInput.effort)
    ) {
      return `effort ${agentInput.effort} is not supported by model ${model}.`;
    }
  }
  if (
    agentInput.configuredThinking !== undefined &&
    !(
      modelEntry.supportsThinking &&
      (!deepAgents || modelEntry.supportsReasoningEffort)
    )
  ) {
    return `thinking is not supported by model ${model}.`;
  }
  if (
    agentInput.configuredThinking?.mode === 'on' &&
    agentInput.configuredThinking.budgetTokens !== undefined &&
    !modelEntry.supportsThinkingBudget
  ) {
    return `thinking.budget_tokens is not supported by model ${model}.`;
  }
  if (
    agentInput.configuredThinking?.mode === 'on' &&
    agentInput.configuredThinking.budgetTokens === undefined &&
    !deepAgents &&
    !modelEntry.supportsAdaptiveThinking
  ) {
    return `thinking is not supported in adaptive mode by model ${model}.`;
  }
  return agentInput.maxOutputTokens !== undefined && !deepAgents
    ? `max_output_tokens is not supported by model ${model}; use effort as the output-quality lever.`
    : null;
}

function inlineRuntimePreSpawnAdmissionError(input: {
  agentInput: AgentInput;
  agentEngine: AgentEngine;
  agentRuntime?: AgentRuntime;
  stdioMcpSourceIds?: readonly string[];
}): string | null {
  const runtime = input.agentRuntime ?? input.agentInput.runtime ?? 'worker';
  if (input.agentInput.responseSchema && runtime === 'worker') {
    return 'response_schema requires an inline agent runtime';
  }
  if (runtime !== 'inline') return null;
  const labels = new Set<string>();
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
  const skillEngineError = inlineAgentSkillEngineConstraintError({
    subject: 'agent',
    agentRuntime: runtime,
    agentEngine: input.agentEngine,
    attachedSkillSourceIds: input.agentInput.attachedSkillSourceIds,
  });
  const workerOnlyError =
    labels.size === 0
      ? null
      : formatInlineAgentWorkerOnlyConfigError('agent', [...labels].sort());
  return [skillEngineError, workerOnlyError].filter(Boolean).join('; ') || null;
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
