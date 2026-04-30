import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import {
  nowIso,
  nowMs,
  parseIso,
  sleep,
} from '../../../infrastructure/time/datetime.js';
import { TASKS_DIR } from '../context.js';
import { formatTaskFailureLines } from '../formatting.js';
import {
  waitForTaskResponse,
  writeIpcFile,
  type TaskResponseEnvelope,
} from '../ipc.js';
import {
  normalizeExecutionMode,
  resolveSchedulerThreadArg,
} from '../scheduler-utils.js';

async function requestSchedulerData(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<TaskResponseEnvelope | null> {
  const taskId = `${type.replace(/_/g, '-')}-${nowMs()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  writeIpcFile(TASKS_DIR, {
    type,
    taskId,
    ...payload,
    timestamp: nowIso(),
  });
  return waitForTaskResponse(taskId, timeoutMs);
}

function taskError(response: TaskResponseEnvelope | null, fallback: string) {
  if (!response) {
    return {
      content: [{ type: 'text' as const, text: `${fallback} timed out.` }],
      isError: true,
    };
  }
  if (!response.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text: formatTaskFailureLines(response, fallback).join('\n'),
        },
      ],
      isError: true,
    };
  }
  return null;
}

function dataRecord(response: TaskResponseEnvelope): Record<string, unknown> {
  return typeof response.data === 'object' &&
    response.data !== null &&
    !Array.isArray(response.data)
    ? (response.data as Record<string, unknown>)
    : {};
}

export function registerSchedulerTools(server: McpServer): void {
  server.tool(
    'scheduler_upsert_job',
    'Create or update a scheduler job. Idempotent by job ID.',
    {
      job_id: z.string().optional(),
      name: z.string(),
      prompt: z.string(),
      model: z.string().optional(),
      schedule_type: z.enum(['cron', 'interval', 'once']),
      schedule_value: z.string().default(''),
      linked_sessions: z.array(z.string()).optional(),
      deliver_to: z.array(z.string()).optional(),
      thread_id: z.string().optional(),
      silent: z.boolean().optional(),
      cleanup_after_ms: z.number().optional(),
      group_scope: z.string().optional(),
      timeout_ms: z.number().optional(),
      max_retries: z.number().optional(),
      retry_backoff_ms: z.number().optional(),
      max_consecutive_failures: z.number().optional(),
      execution_mode: z.enum(['parallel', 'serialized']).optional(),
      serialize: z.boolean().optional(),
    },
    async (args) => {
      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              { type: 'text' as const, text: 'Invalid cron expression.' },
            ],
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
            content: [
              { type: 'text' as const, text: 'Invalid once timestamp.' },
            ],
            isError: true,
          };
        }
      }

      const schedulerThread = resolveSchedulerThreadArg(args.thread_id, true);
      if (schedulerThread.error) {
        return {
          content: [{ type: 'text' as const, text: schedulerThread.error }],
          isError: true,
        };
      }

      const taskId = `scheduler-upsert-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      const data = {
        type: 'scheduler_upsert_job',
        taskId,
        jobId: args.job_id,
        name: args.name,
        prompt: args.prompt,
        model: args.model,
        scheduleType: args.schedule_type,
        scheduleValue: args.schedule_value,
        linkedSessions: args.linked_sessions,
        deliverTo: args.deliver_to,
        ...(schedulerThread.threadId !== undefined
          ? { threadId: schedulerThread.threadId }
          : {}),
        silent: args.silent,
        cleanupAfterMs: args.cleanup_after_ms,
        groupScope: args.group_scope,
        timeoutMs: args.timeout_ms,
        maxRetries: args.max_retries,
        retryBackoffMs: args.retry_backoff_ms,
        maxConsecutiveFailures: args.max_consecutive_failures,
        executionMode: normalizeExecutionMode(
          args.execution_mode,
          args.serialize,
        ),
        serialize: args.serialize,
        createdBy: 'agent',
        timestamp: nowIso(),
      };
      writeIpcFile(TASKS_DIR, data);
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler upsert timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler upsert was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job upsert completed.',
          },
        ],
      };
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
            text: job ? JSON.stringify(job, null, 2) : 'Job not found.',
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
      group_scope: z.string().optional(),
    },
    async (args) => {
      const response = await requestSchedulerData('scheduler_list_jobs', {
        statuses: args.statuses,
        groupScope: args.group_scope,
      });
      const error = taskError(response, 'Scheduler list jobs failed.');
      if (error) return error;
      const jobs = dataRecord(response!).jobs;
      const result = Array.isArray(jobs) ? jobs : [];
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.tool(
    'scheduler_update_job',
    'Update mutable fields on a scheduler job.',
    {
      job_id: z.string(),
      name: z.string().optional(),
      prompt: z.string().optional(),
      model: z.string().optional(),
      schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
      schedule_value: z.string().optional(),
      linked_sessions: z.array(z.string()).optional(),
      deliver_to: z.array(z.string()).optional(),
      thread_id: z.string().optional(),
      silent: z.boolean().optional(),
      cleanup_after_ms: z.number().optional(),
      group_scope: z.string().optional(),
      timeout_ms: z.number().optional(),
      max_retries: z.number().optional(),
      retry_backoff_ms: z.number().optional(),
      max_consecutive_failures: z.number().optional(),
      execution_mode: z.enum(['parallel', 'serialized']).optional(),
      serialize: z.boolean().optional(),
    },
    async (args) => {
      const executionMode =
        args.execution_mode !== undefined || args.serialize !== undefined
          ? normalizeExecutionMode(args.execution_mode, args.serialize)
          : undefined;
      const schedulerThread = resolveSchedulerThreadArg(args.thread_id, false);
      if (schedulerThread.error) {
        return {
          content: [{ type: 'text' as const, text: schedulerThread.error }],
          isError: true,
        };
      }
      const taskId = `scheduler-update-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_update_job',
        taskId,
        jobId: args.job_id,
        name: args.name,
        prompt: args.prompt,
        model: args.model,
        scheduleType: args.schedule_type,
        scheduleValue: args.schedule_value,
        linkedSessions: args.linked_sessions,
        deliverTo: args.deliver_to,
        ...(schedulerThread.threadId !== undefined
          ? { threadId: schedulerThread.threadId }
          : {}),
        silent: args.silent,
        cleanupAfterMs: args.cleanup_after_ms,
        groupScope: args.group_scope,
        timeoutMs: args.timeout_ms,
        maxRetries: args.max_retries,
        retryBackoffMs: args.retry_backoff_ms,
        maxConsecutiveFailures: args.max_consecutive_failures,
        executionMode,
        serialize: args.serialize,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler update timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler update was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job update completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_delete_job',
    'Delete a scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = `scheduler-delete-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_delete_job',
        taskId,
        jobId: args.job_id,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler delete timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler delete was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job delete completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_pause_job',
    'Pause a scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = `scheduler-pause-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_pause_job',
        taskId,
        jobId: args.job_id,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler pause timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler pause was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job pause completed.',
          },
        ],
      };
    },
  );

  server.tool(
    'scheduler_resume_job',
    'Resume a paused scheduler job.',
    { job_id: z.string() },
    async (args) => {
      const taskId = `scheduler-resume-${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(TASKS_DIR, {
        type: 'scheduler_resume_job',
        taskId,
        jobId: args.job_id,
        timestamp: nowIso(),
      });
      const response = await waitForTaskResponse(taskId, 20_000);
      if (!response) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Scheduler resume timed out waiting for host confirmation.',
            },
          ],
          isError: true,
        };
      }
      if (!response.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: formatTaskFailureLines(
                response,
                'Scheduler resume was rejected.',
              ).join('\n'),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: response.message || 'Scheduler job resume completed.',
          },
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
      const timeoutMs = Math.max(
        1_000,
        Math.min(args.timeout_ms ?? 30_000, 120_000),
      );
      const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
      const deadline = nowMs() + timeoutMs;
      while (nowMs() < deadline) {
        const response = await requestSchedulerData(
          'scheduler_list_events',
          {
            jobId: args.job_id,
            runId: args.run_id,
            eventType: args.event_type,
            sinceId: args.since_id,
            since: args.since,
            limit,
          },
          5_000,
        );
        const error = taskError(response, 'Scheduler wait for events failed.');
        if (error) return error;
        const events = dataRecord(response!).events;
        const result = Array.isArray(events) ? events : [];
        if (result.length > 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }
        await sleep(250);
      }
      return {
        content: [{ type: 'text' as const, text: '[]' }],
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
