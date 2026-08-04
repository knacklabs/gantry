import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import {
  resolveAgentToolRuntimePolicy,
  resolveAgentToolRuntimeRules,
} from '../application/agents/agent-tool-runtime-rules.js';
import type { CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';

export interface ConfiguredAgentToolPolicy {
  toolPolicyRules: string[] | undefined;
  runtimeAccess: CapabilityRuntimeAccess[];
  semanticCapabilities: SemanticCapabilityDefinition[];
}

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

export async function resolveConfiguredToolPolicy(input: {
  repository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<ConfiguredAgentToolPolicy> {
  if (!input.repository) {
    return {
      toolPolicyRules: undefined,
      runtimeAccess: [],
      semanticCapabilities: [],
    };
  }
  const policy = await resolveAgentToolRuntimePolicy({
    repository: input.repository,
    appId: input.appId,
    agentId: input.agentId,
    errorSubject: 'Configured agent tool',
    skillRepository: input.skillRepository,
  });
  return {
    toolPolicyRules: policy.rules,
    runtimeAccess: policy.runtimeAccess,
    semanticCapabilities: policy.semanticCapabilities,
  };
}
