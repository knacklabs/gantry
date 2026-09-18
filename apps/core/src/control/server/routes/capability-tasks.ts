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
import { jobArtifactScope } from '../../../domain/ports/job-semantic-checkpoints.js';
import type { FileArtifactId } from '../../../domain/file-artifacts/file-artifact.js';

const BODY_LIMIT_BYTES = 512 * 1024;
const TASK_ROUTE = /^\/v1\/capability-tasks\/([^/]+)\/(complete|cancel)$/u;
const TASK_ARTIFACT_ROUTE =
  /^\/v1\/capability-tasks\/([^/]+)\/artifacts\/read$/u;

export async function handleCapabilityTaskRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/v1/capability-tasks')) return false;
  const artifactMatch = TASK_ARTIFACT_ROUTE.exec(pathname);
  if (artifactMatch && req.method === 'POST') {
    return handleCapabilityArtifactRead(
      req,
      res,
      ctx,
      decodeURIComponent(artifactMatch[1]!),
    );
  }
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

async function handleCapabilityArtifactRead(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  taskId: string,
): Promise<true> {
  const auth = authorizeControlRequest(req, res, ctx.keys, [
    'capability-artifacts:read',
  ]);
  if (!auth) return true;
  const body = await bodyObject(req);
  const completionToken = requiredString(body.completionToken);
  const artifactId = requiredString(body.artifactId);
  if (
    !completionToken ||
    !artifactId ||
    !/^file-artifact:[0-9a-f-]{36}$/iu.test(artifactId)
  ) {
    sendError(
      res,
      400,
      'INVALID_CAPABILITY_ARTIFACT_READ',
      'completionToken and a FileArtifact artifactId are required.',
    );
    return true;
  }
  const storage = getRuntimeStorage();
  const authorization = await new ExternalCapabilityTaskService(
    storage.repositories.asyncTasks,
  ).authorizeArtifactRead({ appId: auth.appId, taskId, completionToken });
  if (authorization.outcome !== 'authorized') {
    const status =
      authorization.outcome === 'not_found'
        ? 404
        : authorization.outcome === 'forbidden'
          ? 403
          : 409;
    sendError(
      res,
      status,
      `CAPABILITY_ARTIFACT_${authorization.outcome.toUpperCase()}`,
      authorization.outcome === 'forbidden'
        ? 'Invalid task token.'
        : authorization.outcome === 'conflict'
          ? 'Task is not waiting for external completion.'
          : 'Task not found.',
    );
    return true;
  }
  const capabilityId = String(
    authorization.task.authoritySnapshotJson.capabilityId ?? '',
  );
  if (!auth.allowedCapabilityIds?.has(capabilityId)) {
    sendError(
      res,
      403,
      'CAPABILITY_ARTIFACT_AUDIENCE_FORBIDDEN',
      'API key is not restricted to this capability.',
    );
    return true;
  }
  const parentJobId = authorization.task.parentJobId;
  if (!parentJobId) {
    sendError(
      res,
      403,
      'CAPABILITY_ARTIFACT_FORBIDDEN',
      'Task has no parent job.',
    );
    return true;
  }
  try {
    const { artifact, content } = await storage.fileArtifacts.readFileArtifact({
      id: artifactId as FileArtifactId,
      appId: auth.appId,
      agentId: authorization.task.agentId,
    });
    if (artifact.virtualScope !== jobArtifactScope(parentJobId)) {
      sendError(
        res,
        403,
        'CAPABILITY_ARTIFACT_SCOPE_INVALID',
        'Artifact does not belong to the capability task parent job.',
      );
      return true;
    }
    const contentType = artifact.contentType
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
      sendError(
        res,
        415,
        'CAPABILITY_ARTIFACT_CONTENT_TYPE_INVALID',
        'Capability artifacts must use a JSON content type.',
      );
      return true;
    }
    const text =
      typeof content === 'string'
        ? content
        : Buffer.from(content).toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > 10 * 1024 * 1024) {
      sendError(
        res,
        413,
        'CAPABILITY_ARTIFACT_TOO_LARGE',
        'Artifact exceeds 10 MiB.',
      );
      return true;
    }
    sendJson(res, 200, {
      artifactId: artifact.id,
      contentHash: artifact.contentHash,
      contentType: artifact.contentType,
      value: JSON.parse(text) as unknown,
    });
  } catch {
    sendError(
      res,
      404,
      'CAPABILITY_ARTIFACT_NOT_FOUND',
      'Artifact was not found or does not contain valid JSON.',
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
