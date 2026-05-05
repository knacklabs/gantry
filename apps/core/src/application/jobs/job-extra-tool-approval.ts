import { ApplicationError } from '../common/application-error.js';
import type { JobExtraToolApprovalRequest } from './job-management-types.js';
import {
  agentIdForJobGroupScope,
  jobToolRulesBeyondInherited,
  resolveAgentToolBindings,
} from './job-tool-policy.js';
import type { JobManagementServiceDeps } from './job-management-types.js';

export async function requireJobExtraToolApproval(input: {
  deps: Pick<
    JobManagementServiceDeps,
    'toolRepository' | 'approveJobExtraTools'
  >;
  jobId: string;
  jobName: string;
  appId: string;
  groupScope: string;
  allowedTools: string[];
  existingJobExtraTools: string[];
  operation: JobExtraToolApprovalRequest['operation'];
}): Promise<void> {
  if (input.allowedTools.length === 0) return;
  const agentId = agentIdForJobGroupScope(input.groupScope);
  const inheritedTools = await resolveAgentToolBindings({
    repository: input.deps.toolRepository,
    appId: input.appId,
    agentId,
  });
  const extrasBeyondInherited = jobToolRulesBeyondInherited({
    requestedRules: input.allowedTools,
    inheritedTools: [...inheritedTools, ...input.existingJobExtraTools],
  });
  if (extrasBeyondInherited.length === 0) return;
  if (!input.deps.approveJobExtraTools) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Job-scoped extra tools require approval before they can be stored.',
    );
  }
  const decision = await input.deps.approveJobExtraTools({
    jobId: input.jobId,
    jobName: input.jobName,
    target: {
      appId: input.appId,
      agentId,
      groupScope: input.groupScope,
    },
    inheritedTools,
    requestedJobExtraTools: input.allowedTools,
    extrasBeyondInherited,
    existingJobExtraTools: input.existingJobExtraTools,
    operation: input.operation,
  });
  if (decision.approved) return;
  throw new ApplicationError(
    'FORBIDDEN',
    `Job-scoped tool approval denied: ${decision.reason || 'not approved'}.`,
  );
}
