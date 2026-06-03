import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { parseIso } from '../../../shared/time/datetime.js';
import { makeIpcId } from '../ipc-ids.js';
import { formatModelCatalog } from '../../../shared/model-catalog-format.js';
import {
  schedulerEventsSummary,
  schedulerJobSummary,
  schedulerJobsSummary,
  schedulerNotificationTargetsSummary,
} from './scheduler-formatters.js';
import {
  formatSchedulerJobPlan,
  schedulerJobConfirmationToken,
  type SchedulerJobPlanInput,
} from '../../../shared/scheduler-job-plan.js';
import {
  canonicalTargetFromArgs,
  normalizeSchedulerWaitTimeoutMs,
  requestSchedulerData,
  schedulerDataRecord as dataRecord,
  schedulerTaskError as taskError,
  submitSchedulerMutationTask,
  SCHEDULER_WAIT_RESPONSE_GRACE_MS,
} from './scheduler-tool-helpers.js';
import {
  schedulerAccessRequirementSchema,
  type SchedulerAccessRequirementInput,
} from './scheduler-capability-schema.js';
const SCHEDULER_UPSERT_ARG_KEYS = new Set([
  'job_id',
  'name',
  'prompt',
  'model_alias',
  'schedule_type',
  'schedule_value',
  'target',
  'execution_context',
  'notification_routes',
  'access_requirements',
  'silent',
  'cleanup_after_ms',
  'timeout_ms',
  'max_retries',
  'retry_backoff_ms',
  'max_consecutive_failures',
  'confirm',
  'confirmation_token',
]);

const SCHEDULER_UPDATE_ARG_KEYS = new Set([
  'job_id',
  'name',
  'prompt',
  'model_alias',
  'schedule_type',
  'schedule_value',
  'target',
  'execution_context',
  'notification_routes',
  'access_requirements',
  'silent',
  'cleanup_after_ms',
  'timeout_ms',
  'max_retries',
  'retry_backoff_ms',
  'max_consecutive_failures',
]);

function removedExecutionScopeFieldError(args: Record<string, unknown>) {
  const containers: unknown[] = [args, args.execution_context];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    if ('group_scope' in container || 'groupScope' in container) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'group_scope/groupScope is no longer accepted. Use workspace_key.',
          },
        ],
        isError: true,
      };
    }
  }
  return null;
}

function unsupportedSchedulerArgError(
  args: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
) {
  const removedScopeError = removedExecutionScopeFieldError(args);
  if (removedScopeError) return removedScopeError;
  if (Object.prototype.hasOwnProperty.call(args, 'required_tools')) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'required_tools is no longer accepted. Use access_requirements for access preflight checks.',
        },
      ],
      isError: true,
    };
  }
  const unsupported = Object.keys(args).filter((key) => !allowedKeys.has(key));
  if (unsupported.length === 0) return null;
  return {
    content: [
      {
        type: 'text' as const,
        text: `Unsupported scheduler fields: ${unsupported.join(
          ', ',
        )}. Use execution_context and notification_routes for routing.`,
      },
    ],
    isError: true,
  };
}

// passthrough() keeps unknown keys alive so the MCP SDK rejects removed
// execution-scope inputs before the handler runs; the normalizer ignores extras.
const executionContextSchema = z
  .object({
    conversation_jid: z.string(),
    thread_id: z.string().nullable(),
    workspace_key: z.string(),
    session_id: z.string().nullable().optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    if ('group_scope' in val || 'groupScope' in val) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'group_scope/groupScope is no longer accepted. Use workspace_key.',
      });
    }
  });

function validateScheduleInput(args: {
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
}) {
  if (args.schedule_type === 'cron') {
    try {
      CronExpressionParser.parse(args.schedule_value);
    } catch {
      return {
        content: [{ type: 'text' as const, text: 'Invalid cron expression.' }],
        isError: true,
      };
    }
  }
  if (args.schedule_type === 'interval') {
    const ms = parseInt(args.schedule_value, 10);
    if (isNaN(ms) || ms <= 0) {
      return {
        content: [
          { type: 'text' as const, text: 'Invalid interval milliseconds.' },
        ],
        isError: true,
      };
    }
  }
  if (args.schedule_type === 'once') {
    const date = parseIso(args.schedule_value);
    if (!date) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid once timestamp.' }],
        isError: true,
      };
    }
  }
  return null;
}

function normalizeSchedulerAccessRequirements(
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

export function registerSchedulerTools(server: McpServer): void {
  server.tool(
    'scheduler_list_models',
    'List supported model aliases for one-time and recurring scheduler jobs.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: formatModelCatalog() }],
    }),
  );
  server.tool(
    'scheduler_upsert_job',
    'Create or update a scheduler job. Idempotent by job ID.',
    {
      job_id: z.string().optional(),
      name: z.string(),
      prompt: z.string(),
      model_alias: z.string().optional(),
      schedule_type: z.enum(['cron', 'interval', 'once']),
      schedule_value: z.string().default(''),
      target: z.enum(['here', 'this_thread', 'this_topic', 'me_dm']).optional(),
      execution_context: executionContextSchema.optional(),
      notification_routes: z
        .array(
          z.object({
            conversation_jid: z.string(),
            thread_id: z.string().nullable(),
            label: z.string(),
          }),
        )
        .optional(),
      access_requirements: z
        .array(schedulerAccessRequirementSchema)
        .optional()
        .describe(
          'Access this job needs as a single list. Each entry has a target: {kind:"capability", capability_id, implementation?} for reviewed semantic capabilities, {kind:"tool_rule", rule} for exact tools/Browser/scoped RunCommand(...), or {kind:"mcp_server", server}. Missing access pauses setup for user approval.',
        ),
      required_tools: z.array(z.string()).optional().describe('Deprecated.'),
      silent: z.boolean().optional(),
      cleanup_after_ms: z.number().optional(),
      timeout_ms: z.number().optional(),
      max_retries: z.number().optional(),
      retry_backoff_ms: z.number().optional(),
      max_consecutive_failures: z.number().optional(),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'Set true only after reviewing the returned plan and passing confirmation_token.',
        ),
      confirmation_token: z
        .string()
        .optional()
        .describe(
          'Token returned by the explain-before-confirm scheduler job plan.',
        ),
    },
    async (args) => {
      const unsupportedArgError = unsupportedSchedulerArgError(
        args as Record<string, unknown>,
        SCHEDULER_UPSERT_ARG_KEYS,
      );
      if (unsupportedArgError) return unsupportedArgError;
      const scheduleError = validateScheduleInput(args);
      if (scheduleError) return scheduleError;
      const canonicalTarget = canonicalTargetFromArgs(
        args as Record<string, unknown>,
        true,
      );
      if (canonicalTarget.error) {
        return {
          content: [{ type: 'text' as const, text: canonicalTarget.error }],
          isError: true,
        };
      }
      const planInput: SchedulerJobPlanInput = {
        jobId: args.job_id,
        name: args.name,
        prompt: args.prompt,
        modelAlias: args.model_alias,
        scheduleType: args.schedule_type,
        scheduleValue: args.schedule_value,
        executionContext: canonicalTarget.executionContext,
        notificationRoutes: canonicalTarget.notificationRoutes,
        accessRequirements: normalizeSchedulerAccessRequirements(
          args.access_requirements,
        ),
        silent: args.silent,
        cleanupAfterMs: args.cleanup_after_ms,
        timeoutMs: args.timeout_ms,
        maxRetries: args.max_retries,
        retryBackoffMs: args.retry_backoff_ms,
        maxConsecutiveFailures: args.max_consecutive_failures,
        createdBy: 'agent',
      };
      const confirmationToken = schedulerJobConfirmationToken(planInput);
      if (args.confirm !== true) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatSchedulerJobPlan({
                ...planInput,
                confirmationToken,
              }),
            },
          ],
        };
      }
      if (args.confirmation_token !== confirmationToken) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler upsert confirmation token is missing or does not match the current job plan. Re-run with confirm=false to get a fresh plan.',
            },
          ],
          isError: true,
        };
      }
      const taskId = makeIpcId('scheduler-upsert');
      return submitSchedulerMutationTask({
        taskType: 'scheduler_upsert_job',
        taskId,
        payload: {
          ...planInput,
          confirm: true,
          confirmationToken,
        },
        timeoutText:
          'Scheduler upsert timed out waiting for host confirmation.',
        rejectedText: 'Scheduler upsert was rejected.',
        successText: 'Scheduler job upsert completed.',
      });
    },
  );
  server.tool(
    'scheduler_get_job',
    'Get one scheduler job by ID from the host scheduler.',
    { job_id: z.string() },
    async (args) => {
      const response = await requestSchedulerData('scheduler_get_job', {
        jobId: args.job_id,
      });
      const error = taskError(response, 'Scheduler get job failed.');
      if (error) return error;
      const job = dataRecord(response!).job ?? null;
      return {
        content: [
          {
            type: 'text' as const,
            text: job ? schedulerJobSummary(job) : 'Job not found.',
          },
        ],
      };
    },
  );
  server.tool(
    'scheduler_list_jobs',
    'List scheduler jobs from the host scheduler.',
    {
      statuses: z.array(z.string()).optional(),
      kind: z.enum(['manual', 'once', 'recurring']).optional(),
      limit: z.number().optional(),
    },
    async (args) => {
      const response = await requestSchedulerData('scheduler_list_jobs', {
        statuses: args.statuses,
        kind: args.kind,
        limit: args.limit,
      });
      const error = taskError(response, 'Scheduler list jobs failed.');
      if (error) return error;
      const jobs = dataRecord(response!).jobs;
      const result = Array.isArray(jobs) ? jobs : [];
      return {
        content: [
          { type: 'text' as const, text: schedulerJobsSummary(result) },
        ],
      };
    },
  );
  server.tool(
    'scheduler_list_notification_targets',
    'List valid notification targets for scheduler jobs in the current conversation context.',
    {},
    async () => {
      const response = await requestSchedulerData(
        'scheduler_list_notification_targets',
        {},
      );
      const error = taskError(
        response,
        'Scheduler notification target listing failed.',
      );
      if (error) return error;
      const targets = dataRecord(response!).targets;
      const result = Array.isArray(targets) ? targets : [];
      const text = schedulerNotificationTargetsSummary(result);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
  server.tool(
    'scheduler_update_job',
    'Update mutable fields on a scheduler job.',
    {
      job_id: z.string(),
      name: z.string().optional(),
      prompt: z.string().optional(),
      model_alias: z.string().nullable().optional(),
      schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
      schedule_value: z.string().optional(),
      target: z.enum(['here', 'this_thread', 'this_topic', 'me_dm']).optional(),
      execution_context: executionContextSchema.optional(),
      notification_routes: z
        .array(
          z.object({
            conversation_jid: z.string(),
            thread_id: z.string().nullable(),
            label: z.string(),
          }),
        )
        .optional(),
      access_requirements: z
        .array(schedulerAccessRequirementSchema)
        .optional()
        .describe(
          'Access this job needs as a single list. Each entry has a target: {kind:"capability", capability_id, implementation?} for reviewed semantic capabilities, {kind:"tool_rule", rule} for exact tools/Browser/scoped RunCommand(...), or {kind:"mcp_server", server}. Missing access pauses setup for user approval.',
        ),
      required_tools: z.array(z.string()).optional().describe('Deprecated.'),
      silent: z.boolean().optional(),
      cleanup_after_ms: z.number().optional(),
      timeout_ms: z.number().optional(),
      max_retries: z.number().optional(),
      retry_backoff_ms: z.number().optional(),
      max_consecutive_failures: z.number().optional(),
    },
    async (args) => {
      const unsupportedArgError = unsupportedSchedulerArgError(
        args as Record<string, unknown>,
        SCHEDULER_UPDATE_ARG_KEYS,
      );
      if (unsupportedArgError) return unsupportedArgError;
      const canonicalTarget = canonicalTargetFromArgs(
        args as Record<string, unknown>,
        false,
      );
      if (canonicalTarget.error) {
        return {
          content: [{ type: 'text' as const, text: canonicalTarget.error }],
          isError: true,
        };
      }
      const taskId = makeIpcId('scheduler-update');
      return submitSchedulerMutationTask({
        taskType: 'scheduler_update_job',
        taskId,
        payload: {
          jobId: args.job_id,
          name: args.name,
          prompt: args.prompt,
          modelAlias: args.model_alias,
          scheduleType: args.schedule_type,
          scheduleValue: args.schedule_value,
          ...(args.execution_context !== undefined || args.target !== undefined
            ? { executionContext: canonicalTarget.executionContext }
            : {}),
          ...(args.notification_routes !== undefined ||
          args.target !== undefined
            ? { notificationRoutes: canonicalTarget.notificationRoutes }
            : {}),
          ...(args.access_requirements !== undefined
            ? {
                accessRequirements: normalizeSchedulerAccessRequirements(
                  args.access_requirements,
                ),
              }
            : {}),
          silent: args.silent,
          cleanupAfterMs: args.cleanup_after_ms,
          timeoutMs: args.timeout_ms,
          maxRetries: args.max_retries,
          retryBackoffMs: args.retry_backoff_ms,
          maxConsecutiveFailures: args.max_consecutive_failures,
        },
        timeoutText:
          'Scheduler update timed out waiting for host confirmation.',
        rejectedText: 'Scheduler update was rejected.',
        successText: 'Scheduler job update completed.',
      });
    },
  );
  server.tool(
    'scheduler_delete_job',
    'Delete a scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = makeIpcId('scheduler-delete');
      return submitSchedulerMutationTask({
        taskType: 'scheduler_delete_job',
        taskId,
        payload: { jobId: args.job_id },
        timeoutText:
          'Scheduler delete timed out waiting for host confirmation.',
        rejectedText: 'Scheduler delete was rejected.',
        successText: 'Scheduler job delete completed.',
      });
    },
  );
  server.tool(
    'scheduler_pause_job',
    'Pause a scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = makeIpcId('scheduler-pause');
      return submitSchedulerMutationTask({
        taskType: 'scheduler_pause_job',
        taskId,
        payload: { jobId: args.job_id },
        timeoutText: 'Scheduler pause timed out waiting for host confirmation.',
        rejectedText: 'Scheduler pause was rejected.',
        successText: 'Scheduler job pause completed.',
      });
    },
  );
  server.tool(
    'scheduler_resume_job',
    'Resume a paused scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = makeIpcId('scheduler-resume');
      return submitSchedulerMutationTask({
        taskType: 'scheduler_resume_job',
        taskId,
        payload: { jobId: args.job_id },
        timeoutText:
          'Scheduler resume timed out waiting for host confirmation.',
        rejectedText: 'Scheduler resume was rejected.',
        successText: 'Scheduler job resume completed.',
      });
    },
  );
  server.tool(
    'scheduler_run_now',
    'Queue an immediate run of an existing scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const response = await requestSchedulerData('scheduler_run_now', {
        jobId: args.job_id,
      });
      const error = taskError(response, 'Scheduler run-now failed.');
      if (error) return error;
      const data = dataRecord(response!);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );
  server.tool(
    'scheduler_list_runs',
    'List job runs from the host scheduler.',
    {
      job_id: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) => {
      const response = await requestSchedulerData('scheduler_list_runs', {
        jobId: args.job_id,
        limit: args.limit,
      });
      const error = taskError(response, 'Scheduler list runs failed.');
      if (error) return error;
      const runs = dataRecord(response!).runs;
      const result = Array.isArray(runs) ? runs : [];
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'scheduler_list_events',
    'List scheduler lifecycle events from the host scheduler.',
    {
      job_id: z.string().optional(),
      run_id: z.string().optional(),
      event_type: z.string().optional(),
      since_id: z.number().optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
    async (args) => {
      const response = await requestSchedulerData('scheduler_list_events', {
        jobId: args.job_id,
        runId: args.run_id,
        eventType: args.event_type,
        sinceId: args.since_id,
        since: args.since,
        limit: args.limit,
      });
      const error = taskError(response, 'Scheduler list events failed.');
      if (error) return error;
      const events = dataRecord(response!).events;
      const result = Array.isArray(events) ? events : [];
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'scheduler_wait_for_events',
    'Wait for scheduler lifecycle events from the host scheduler.',
    {
      job_id: z.string().optional(),
      run_id: z.string().optional(),
      event_type: z.string().optional(),
      since_id: z.number().optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
      timeout_ms: z.number().optional(),
    },
    async (args) => {
      const timeoutMs = normalizeSchedulerWaitTimeoutMs(args.timeout_ms);
      const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
      const response = await requestSchedulerData(
        'scheduler_wait_for_events',
        {
          jobId: args.job_id,
          runId: args.run_id,
          eventType: args.event_type,
          sinceId: args.since_id,
          since: args.since,
          limit,
          timeoutMs,
        },
        timeoutMs + SCHEDULER_WAIT_RESPONSE_GRACE_MS,
      );
      const error = taskError(response, 'Scheduler wait for events failed.');
      if (error) return error;
      const events = dataRecord(response!).events;
      const result = Array.isArray(events) ? events : [];
      return {
        content: [
          {
            type: 'text' as const,
            text: schedulerEventsSummary(result),
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_get_dead_letter',
    'List dead-lettered job runs from the host scheduler.',
    { limit: z.number().optional() },
    async (args) => {
      const response = await requestSchedulerData('scheduler_get_dead_letter', {
        limit: args.limit,
      });
      const error = taskError(response, 'Scheduler dead letter query failed.');
      if (error) return error;
      const runs = dataRecord(response!).deadLetterRuns;
      const result = Array.isArray(runs) ? runs : [];
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );
}
