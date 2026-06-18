import type { AgentEngine } from '../shared/agent-engine.js';
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
  sandboxProvider: RunnerSandboxProviderId | undefined;
  securityEnv: NodeJS.ProcessEnv;
}): string | null {
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
