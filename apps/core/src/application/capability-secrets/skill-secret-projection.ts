import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  CapabilitySecretRepository,
  SkillCatalogRepository,
} from '../../domain/ports/repositories.js';
import { CapabilitySecretService } from './capability-secret-service.js';
import type {
  CapabilityRuntimeAccess,
  SkillActionCapabilityRuntimeAccess,
} from '../../shared/capability-runtime-access.js';

export async function resolveSelectedSkillEnvForAgent(input: {
  appId: AppId;
  agentId: AgentId;
  skills: SkillCatalogRepository;
  secrets: CapabilitySecretRepository;
  runtimeAccess: readonly CapabilityRuntimeAccess[];
}): Promise<{
  env: Record<string, string>;
}> {
  const selectedSkills = await input.skills.listEnabledSkillsForAgent({
    appId: input.appId,
    agentId: input.agentId,
  });
  const attachedSkillSourceIds = new Set(
    selectedSkills.map((skill) => skill.id),
  );
  const skillActionAccess = input.runtimeAccess.filter(
    (access): access is SkillActionCapabilityRuntimeAccess =>
      access.sourceType === 'skill_action' &&
      attachedSkillSourceIds.has(access.skillId as never),
  );
  const requiredEnvVars = skillActionAccess.flatMap(
    (access) => access.declaredEnvRefs,
  );
  if (requiredEnvVars.length === 0) return { env: {} };
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
