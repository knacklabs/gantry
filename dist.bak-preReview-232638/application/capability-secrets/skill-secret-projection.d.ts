import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { CapabilitySecretRepository, SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { CapabilityRuntimeAccess } from '../../shared/capability-runtime-access.js';
export declare function resolveSelectedSkillEnvForAgent(input: {
    appId: AppId;
    agentId: AgentId;
    skills: SkillCatalogRepository;
    secrets: CapabilitySecretRepository;
    runtimeAccess: readonly CapabilityRuntimeAccess[];
}): Promise<{
    env: Record<string, string>;
}>;
