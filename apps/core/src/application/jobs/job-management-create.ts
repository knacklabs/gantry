import { ApplicationError } from '../common/application-error.js';
import type {
  CreateManagedJobInput,
  JobManagementServiceDeps,
} from './job-management-types.js';
import { resolveRequestedJobModel } from './job-model-selection.js';
import { requireJobExtraToolApproval } from './job-extra-tool-approval.js';
import {
  agentIdForJobGroupScope,
  assertJobExtraToolsAllowedForTarget,
  normalizeJobExtraTools,
  resolveAgentToolBindings,
} from './job-tool-policy.js';

export async function createManagedJob(
  deps: JobManagementServiceDeps,
  input: CreateManagedJobInput,
) {
  if (!deps.control) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Job control repository unavailable',
    );
  }
  const session = await deps.control.getAppSessionById(input.sessionId);
  if (!input.name.trim() || !input.prompt.trim() || !session) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'name, prompt, and sessionId are required',
    );
  }
  if (session.appId !== input.appId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'API key cannot access this session',
    );
  }

  const kind = input.kind ?? 'manual';
  const schedule = deps.schedulePlanner.planAppSchedule({
    kind,
    runAt: input.runAt,
    schedule: input.schedule,
  });
  const modelAlias = resolveRequestedJobModel(
    input.modelAlias,
    input.modelProfileId,
  );
  const jobId = deps.schedulePlanner.createManualJobId();
  const runtimeContext = {
    sessionId: session.sessionId,
    chatJid: session.chatJid,
    groupScope: session.workspaceKey,
    threadId: typeof input.threadId === 'string' ? input.threadId : null,
  };
  const allowedTools = normalizeJobExtraTools(input.allowedTools);
  const inheritedTools = await resolveAgentToolBindings({
    repository: deps.toolRepository,
    appId: input.appId,
    agentId: agentIdForJobGroupScope(session.workspaceKey),
  });
  assertJobExtraToolsAllowedForTarget({
    rules: allowedTools,
    inheritedTools,
  });
  if (input.dryRun === true) {
    return { jobId, created: false, modelAlias, runtimeContext };
  }
  await requireJobExtraToolApproval({
    deps,
    jobId,
    jobName: input.name.trim(),
    appId: input.appId,
    groupScope: session.workspaceKey,
    allowedTools,
    existingJobExtraTools: [],
    operation: 'create',
  });
  const result = await deps.ops.upsertJob({
    id: jobId,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    model: modelAlias ?? null,
    script: null,
    schedule_type: schedule.scheduleType,
    schedule_value: schedule.scheduleValue,
    status: 'active',
    linked_sessions: [session.chatJid],
    session_id: null,
    thread_id: typeof input.threadId === 'string' ? input.threadId : null,
    group_scope: session.workspaceKey,
    created_by: 'human',
    next_run: schedule.nextRun,
    execution_mode:
      input.executionMode === 'serialized' ? 'serialized' : 'parallel',
    capability_policy: { allowed_tools: allowedTools },
  });
  deps.scheduler.requestSchedulerSync(jobId);
  return { jobId, created: result.created, modelAlias, runtimeContext };
}
