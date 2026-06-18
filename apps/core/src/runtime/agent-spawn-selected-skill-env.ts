import { resolveSelectedSkillEnvForAgent } from '../application/capability-secrets/skill-secret-projection.js';
import type { CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import type { RunAgentOptions } from './agent-spawn-types.js';

export function resolveSelectedSkillEnvForSpawn(input: {
  options?: RunAgentOptions;
  effectiveRuntimeAccess: CapabilityRuntimeAccess[];
}): Promise<{ env: Record<string, string> }> {
  const options = input.options;
  return options?.skillRepository &&
    options.capabilitySecretRepository &&
    options.skillContext?.appId &&
    options.skillContext.agentId
    ? resolveSelectedSkillEnvForAgent({
        appId: options.skillContext.appId as never,
        agentId: options.skillContext.agentId as never,
        skills: options.skillRepository,
        secrets: options.capabilitySecretRepository,
        runtimeAccess: input.effectiveRuntimeAccess,
      })
    : Promise.resolve({ env: {} });
}
