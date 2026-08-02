import { resolveSelectedSkillEnvForAgent } from '../application/capability-secrets/skill-secret-projection.js';
export function resolveSelectedSkillEnvForSpawn(input) {
    const options = input.options;
    return options?.skillRepository &&
        options.capabilitySecretRepository &&
        options.skillContext?.appId &&
        options.skillContext.agentId
        ? resolveSelectedSkillEnvForAgent({
            appId: options.skillContext.appId,
            agentId: options.skillContext.agentId,
            skills: options.skillRepository,
            secrets: options.capabilitySecretRepository,
            runtimeAccess: input.effectiveRuntimeAccess,
        })
        : Promise.resolve({ env: {} });
}
