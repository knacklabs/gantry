import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  CapabilitySecretRepository,
  SkillCatalogRepository,
} from '../../domain/ports/repositories.js';
import {
  CapabilitySecretService,
  missingSecretMessage,
} from './capability-secret-service.js';

export async function resolveSelectedSkillEnvForAgent(input: {
  appId: AppId;
  agentId: AgentId;
  skills: SkillCatalogRepository;
  secrets: CapabilitySecretRepository;
}): Promise<{
  env: Record<string, string>;
  missingMessage?: string;
}> {
  const selectedSkills = await input.skills.listEnabledSkillsForAgent({
    appId: input.appId,
    agentId: input.agentId,
  });
  const requiredEnvVars = selectedSkills.flatMap(
    (skill) => skill.requiredEnvVars ?? [],
  );
  if (requiredEnvVars.length === 0) return { env: {} };
  const allowedCapabilityIds = selectedSkills.flatMap((skill) => [
    skill.id,
    `skill:${skill.name}`,
  ]);
  const resolved = await new CapabilitySecretService(input.secrets).resolveEnv({
    appId: input.appId,
    names: requiredEnvVars,
    allowedCapabilityIds,
  });
  return {
    env: resolved.env,
    ...(resolved.missing.length > 0
      ? { missingMessage: missingSecretMessage(resolved.missing) }
      : {}),
  };
}
