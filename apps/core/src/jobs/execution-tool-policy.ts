import type { Job } from '../domain/types.js';
import type { ToolCatalogRepository } from '../domain/ports/repositories.js';
import { resolveJobToolPolicy } from '../application/jobs/job-tool-policy.js';

export async function resolveExecutionAllowedTools(input: {
  job: Job;
  appId?: string;
  agentId?: string;
  toolRepository?: ToolCatalogRepository;
}): Promise<string[]> {
  const policy = await resolveJobToolPolicy(input);
  return policy.effectiveAllowedTools;
}
