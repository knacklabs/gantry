import type { Job } from '../../domain/types.js';
import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import { resolveAgentToolRuntimeRules } from '../agents/agent-tool-runtime-rules.js';

export interface JobToolPolicyResolution {
  inheritedTools: string[];
  effectiveAllowedTools: string[];
}

export function agentIdForJobGroupScope(groupScope: string): string {
  const trimmed = groupScope.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

export async function resolveJobToolPolicy(input: {
  job: Job;
  appId?: string;
  agentId?: string;
  toolRepository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
}): Promise<JobToolPolicyResolution> {
  const inheritedTools =
    input.appId && input.agentId
      ? await resolveAgentToolBindings({
          repository: input.toolRepository,
          appId: input.appId,
          agentId: input.agentId,
          skillRepository: input.skillRepository,
        })
      : [];
  return {
    inheritedTools,
    effectiveAllowedTools: mergeUnique(inheritedTools),
  };
}

export async function resolveAgentToolBindings(input: {
  repository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<string[]> {
  if (!input.repository) return [];
  return resolveAgentToolRuntimeRules({
    repository: input.repository,
    appId: input.appId,
    agentId: input.agentId,
    errorSubject: 'Inherited agent tool',
    skillRepository: input.skillRepository,
    makeError: (message) => new ApplicationError('FORBIDDEN', message),
  });
}

function mergeUnique(base: readonly string[]): string[] {
  const out = new Set<string>();
  for (const item of base) {
    const value = item.trim();
    if (value) out.add(value);
  }
  return [...out];
}
