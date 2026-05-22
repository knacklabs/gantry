import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import { resolveAgentToolRuntimeRules } from '../application/agents/agent-tool-runtime-rules.js';

export async function resolveConfiguredAllowedTools(input: {
  repository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<string[] | undefined> {
  if (!input.repository) return undefined;
  return resolveAgentToolRuntimeRules({
    repository: input.repository,
    appId: input.appId,
    agentId: input.agentId,
    errorSubject: 'Configured agent tool',
    skillRepository: input.skillRepository,
  });
}
