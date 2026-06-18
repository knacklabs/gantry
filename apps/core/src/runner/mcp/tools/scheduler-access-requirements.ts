import type { SchedulerJobPlanInput } from '../../../shared/scheduler-job-plan.js';
import type { SchedulerAccessRequirementInput } from './scheduler-capability-schema.js';

export function normalizeSchedulerAccessRequirements(
  input: SchedulerAccessRequirementInput[] | undefined,
): SchedulerJobPlanInput['accessRequirements'] {
  return input?.map((requirement) => {
    const target = requirement.target;
    if (target.kind === 'tool_rule') {
      return {
        target: { kind: 'tool_rule' as const, rule: target.rule },
        ...(requirement.reason ? { reason: requirement.reason } : {}),
      };
    }
    if (target.kind === 'mcp_server') {
      return {
        target: { kind: 'mcp_server' as const, server: target.server },
        ...(requirement.reason ? { reason: requirement.reason } : {}),
      };
    }
    return {
      target: {
        kind: 'capability' as const,
        capabilityId: target.capability_id,
        ...(target.implementation
          ? {
              implementation: {
                kind: target.implementation.kind,
                name: target.implementation.name,
                executablePath: target.implementation.executable_path,
                executableVersion: target.implementation.executable_version,
                executableHash: target.implementation.executable_hash,
                commandTemplate: target.implementation.command_template,
                authPreflight: target.implementation.auth_preflight,
                protectedPaths: target.implementation.protected_paths,
                networkHosts: target.implementation.network_hosts,
              },
            }
          : {}),
      },
      ...(requirement.reason ? { reason: requirement.reason } : {}),
    };
  });
}
