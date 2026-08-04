import { CapabilitySecretService } from './capability-secret-service.js';
export async function resolveSelectedSkillEnvForAgent(input) {
    const selectedSkills = await input.skills.listEnabledSkillsForAgent({
        appId: input.appId,
        agentId: input.agentId,
    });
    const attachedSkillSourceIds = new Set(selectedSkills.map((skill) => skill.id));
    const skillActionAccess = input.runtimeAccess.filter((access) => access.sourceType === 'skill_action' &&
        attachedSkillSourceIds.has(access.skillId));
    const requiredEnvVars = skillActionAccess.flatMap((access) => access.declaredEnvRefs);
    if (requiredEnvVars.length === 0)
        return { env: {} };
    const allowedCapabilityIds = selectedSkills.flatMap((skill) => [
        skill.id,
        `skill:${skill.name}`,
    ]);
    for (const access of skillActionAccess) {
        allowedCapabilityIds.push(access.selectedCapabilityId);
    }
    const resolved = await new CapabilitySecretService(input.secrets).resolveEnv({
        appId: input.appId,
        names: requiredEnvVars,
        allowedCapabilityIds,
    });
    return { env: resolved.env };
}
