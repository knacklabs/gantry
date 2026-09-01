import type { Job } from '../../domain/types.js';
import type {
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import {
  resolveAgentToolRuntimePolicy,
  resolveAgentToolRuntimePolicyFromSnapshot,
  resolveAgentToolRuntimeRules,
} from '../agents/agent-tool-runtime-rules.js';
import type { CapabilityRuntimeAccess } from '../../shared/capability-runtime-access.js';
import {
  assertHostAccessSnapshot,
  type AgentAccessSnapshot,
} from '../agent-execution/agent-access-snapshot.js';
import { requireRegisteredRuntimeProfile } from '../../shared/registered-runtime-profiles.js';

export interface JobToolPolicyResolution {
  inheritedTools: string[];
  effectiveAllowedTools: string[];
  runtimeAccess: CapabilityRuntimeAccess[];
}

export function addRuntimeProfileToolRules(
  policy: JobToolPolicyResolution,
  runtimeProfile: NonNullable<Job['agent_task']>['runtimeProfile'],
): JobToolPolicyResolution {
  const profile = requireRegisteredRuntimeProfile(runtimeProfile);
  if (!profile) return policy;
  return {
    ...policy,
    effectiveAllowedTools: mergeUnique([
      ...policy.effectiveAllowedTools,
      ...profile.additionalToolRules,
    ]),
  };
}

export function agentIdForJobWorkspaceKey(workspaceKey: string): string {
  const trimmed = workspaceKey.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

export async function resolveJobToolPolicy(input: {
  job: Job;
  appId?: string;
  agentId?: string;
  toolRepository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  accessSnapshot?: AgentAccessSnapshot;
}): Promise<JobToolPolicyResolution> {
  const inheritedTools =
    input.appId && input.agentId
      ? input.accessSnapshot
        ? resolveAgentToolBindingPolicyFromSnapshot({
            accessSnapshot: assertHostAccessSnapshot({
              accessSnapshot: input.accessSnapshot,
              appId: input.appId,
              agentId: input.agentId,
              subject: 'Job tool policy',
            })!,
          })
        : await resolveAgentToolBindingPolicy({
            repository: input.toolRepository,
            appId: input.appId,
            agentId: input.agentId,
            skillRepository: input.skillRepository,
          })
      : {
          rules: [],
          runtimeAccess: [],
        };
  return {
    inheritedTools: inheritedTools.rules,
    effectiveAllowedTools: mergeUnique(inheritedTools.rules),
    runtimeAccess: inheritedTools.runtimeAccess,
  };
}

function resolveAgentToolBindingPolicyFromSnapshot(input: {
  accessSnapshot: AgentAccessSnapshot;
}): {
  rules: string[];
  runtimeAccess: CapabilityRuntimeAccess[];
} {
  const policy = resolveAgentToolRuntimePolicyFromSnapshot({
    appId: input.accessSnapshot.appId,
    errorSubject: 'Inherited agent tool',
    selectedToolDefinitionsByBinding:
      input.accessSnapshot.tools.activeBindings.map((row) => row.definition),
    activeSkillDefinitions: input.accessSnapshot.skills.enabledDefinitions,
    makeError: (message) => new ApplicationError('FORBIDDEN', message),
  });
  return {
    rules: policy.rules,
    runtimeAccess: policy.runtimeAccess,
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

export async function resolveAgentToolBindingPolicy(input: {
  repository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  appId: string;
  agentId: string;
}): Promise<{
  rules: string[];
  runtimeAccess: CapabilityRuntimeAccess[];
}> {
  if (!input.repository) {
    return {
      rules: [],
      runtimeAccess: [],
    };
  }
  const policy = await resolveAgentToolRuntimePolicy({
    repository: input.repository,
    appId: input.appId,
    agentId: input.agentId,
    errorSubject: 'Inherited agent tool',
    skillRepository: input.skillRepository,
    makeError: (message) => new ApplicationError('FORBIDDEN', message),
  });
  return {
    rules: policy.rules,
    runtimeAccess: policy.runtimeAccess,
  };
}

function mergeUnique(base: readonly string[]): string[] {
  const out = new Set<string>();
  for (const item of base) {
    const value = item.trim();
    if (value) out.add(value);
  }
  return [...out];
}
