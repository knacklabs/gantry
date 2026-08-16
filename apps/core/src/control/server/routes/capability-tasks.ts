import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { ExternalCapabilityTaskService } from '../../../application/capabilities/external-capability-task-service.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import {
  TRIGGER_RATE_LIMIT_PER_APP,
  TRIGGER_RATE_LIMIT_PER_JOB,
} from '../rate-limit.js';

const BODY_LIMIT_BYTES = 512 * 1024;
const TASK_ROUTE = /^\/v1\/capability-tasks\/([^/]+)\/(complete|cancel)$/u;

export async function handleCapabilityTaskRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/v1/capability-tasks')) return false;
  const auth = authorizeControlRequest(req, res, ctx.keys, ['jobs:write']);
  if (!auth) return true;
  if (pathname === '/v1/capability-tasks/recover' && req.method === 'POST') {
    const body = await bodyObject(req);
    const idempotencyKey = requiredString(body.idempotencyKey);
    const capabilityId = requiredString(body.capabilityId);
    const operation = requiredString(body.operation);
    if (!idempotencyKey || !capabilityId || !operation) {
      sendError(
        res,
        400,
        'INVALID_CAPABILITY_TASK_RECOVERY',
        'idempotencyKey, capabilityId, and operation are required.',
      );
      return true;
    }
    const service = new ExternalCapabilityTaskService(
      getRuntimeStorage().repositories.asyncTasks,
    );
    const recovered = await service.recover({
      appId: auth.appId,
      idempotencyKey,
      capabilityId,
      operation,
    });
    if (!recovered) {
      sendError(
        res,
        404,
        'CAPABILITY_TASK_NOT_RECOVERABLE',
        'No matching waiting capability task can be recovered.',
      );
      return true;
    }
    sendJson(res, 200, recovered);
    return true;
  }

  const match = TASK_ROUTE.exec(pathname);
  if (!match || req.method !== 'POST') return false;
  const taskId = decodeURIComponent(match[1]!);
  const action = match[2]!;
  const body = await bodyObject(req);
  const completionToken = requiredString(body.completionToken);
  if (!completionToken) {
    sendError(
      res,
      400,
      'INVALID_CAPABILITY_TASK_TOKEN',
      'completionToken is required.',
    );
    return true;
  }
  const requiredFields =
    action === 'complete'
      ? [body.completionId, body.resultRef, body.summary]
      : [body.cancellationId, body.reason];
  if (requiredFields.some((value) => !requiredString(value))) {
    sendError(
      res,
      400,
      'INVALID_CAPABILITY_TASK_SETTLEMENT',
      action === 'complete'
        ? 'completionId, resultRef, and summary are required.'
        : 'cancellationId and reason are required.',
    );
    return true;
  }
  const service = new ExternalCapabilityTaskService(
    getRuntimeStorage().repositories.asyncTasks,
  );
  const settlement =
    action === 'complete'
      ? await service.complete({
          appId: auth.appId,
          taskId,
          completionToken,
          completionId: requiredString(body.completionId) ?? '',
          resultRef: requiredString(body.resultRef) ?? '',
          summary: requiredString(body.summary) ?? '',
          result: object(body.result),
        })
      : await service.cancel({
          appId: auth.appId,
          taskId,
          completionToken,
          cancellationId: requiredString(body.cancellationId) ?? '',
          reason: requiredString(body.reason) ?? '',
        });
  if (settlement.outcome === 'not_found') {
    sendError(res, 404, 'CAPABILITY_TASK_NOT_FOUND', 'Task not found.');
  } else if (settlement.outcome === 'forbidden') {
    sendError(res, 403, 'CAPABILITY_TASK_FORBIDDEN', 'Invalid task token.');
  } else if (settlement.outcome === 'conflict') {
    sendError(
      res,
      409,
      'CAPABILITY_TASK_CONFLICT',
      'Task is not waiting for external completion.',
    );
  } else if ('task' in settlement) {
    let resumed = false;
    let triggerId: string | null = null;
    if (
      action === 'complete' &&
      (settlement.outcome === 'completed' ||
        settlement.outcome === 'idempotent') &&
      settlement.task.parentJobId
    ) {
      const job = await ctx.jobManagement.getJob({
        appId: auth.appId,
        jobId: settlement.task.parentJobId,
      });
      const waitingForThisTask =
        job.job?.status === 'paused' &&
        job.job.pause_reason?.includes(settlement.task.id);
      if (waitingForThisTask) {
        const resume = await ctx.jobManagement.resumeJob({
          appId: auth.appId,
          jobId: settlement.task.parentJobId,
        });
        if (resume.resumed) {
          try {
            const trigger = await ctx.jobManagement.triggerJob({
              appId: auth.appId,
              jobId: settlement.task.parentJobId,
              perAppLimit: TRIGGER_RATE_LIMIT_PER_APP,
              perJobLimit: TRIGGER_RATE_LIMIT_PER_JOB,
            });
            triggerId = trigger.triggerId;
            resumed = true;
          } catch (error) {
            await ctx.jobManagement.pauseJob({
              appId: auth.appId,
              jobId: settlement.task.parentJobId,
              reason: `Waiting for external capability task ${settlement.task.id}; continuation enqueue failed.`,
            });
            throw error;
          }
        }
      }
    }
    sendJson(res, 200, {
      outcome: settlement.outcome,
      taskId: settlement.task.id,
      status: settlement.task.status,
      resumed,
      triggerId,
    });
  } else {
    sendError(
      res,
      409,
      'CAPABILITY_TASK_CONFLICT',
      'Capability task settlement could not be applied.',
    );
  }
  return true;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function bodyObject(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const value = await readJson(req, BODY_LIMIT_BYTES);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
