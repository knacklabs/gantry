import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  ActivityDetailResponse,
  ActivityInvalidation,
  ActivityRun,
  ActivityTask,
} from '@gantry/contracts';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type {
  AgentRun,
  AgentRunId,
  RuntimeEvent,
} from '../../../domain/events/events.js';
import type { AsyncTaskRecord } from '../../../domain/ports/async-tasks.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';

const TASK_LIMIT = 100;

export async function handleActivityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/activity' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const runs =
      await getRuntimeStorage().repositories.agentRuns.listRecentAgentRuns(
        auth.appId as AgentRun['appId'],
      );
    const now = Date.now();
    sendJson(res, 200, {
      runs: runs.slice(0, 50).map((run) => projectRun(run, now)),
    });
    return true;
  }

  const route = parseActivityRoute(pathname);
  if (!route || req.method !== 'GET') return false;
  const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
  if (!auth) return true;

  const storage = getRuntimeStorage();
  const run = await storage.repositories.agentRuns.getAgentRunForApp({
    appId: auth.appId as AgentRun['appId'],
    runId: route.runId as AgentRunId,
  });
  if (!run) {
    sendError(res, 404, 'RUN_NOT_FOUND', 'Run not found');
    return true;
  }

  if (route.action === 'events') {
    return handleActivityEvents(req, res, ctx, url, run);
  }

  const [tasks, statusCounts] = await Promise.all([
    storage.repositories.asyncTasks.listTasks({
      appId: auth.appId,
      parentRunId: run.id,
      limit: TASK_LIMIT,
      order: 'created_oldest_first',
    }),
    storage.repositories.asyncTasks.countTasksByStatus({
      appId: auth.appId,
      parentRunId: run.id,
    }),
  ]);
  const taskTotal = statusCounts.reduce((total, item) => total + item.count, 0);
  const boundedTasks = tasks.slice(0, TASK_LIMIT);
  const now = Date.now();
  const detail: ActivityDetailResponse = {
    run: projectRun(run, now),
    tasks: projectTaskTree(boundedTasks, now),
    taskTotal,
    truncated: taskTotal > boundedTasks.length,
  };
  sendJson(res, 200, detail);
  return true;
}

async function handleActivityEvents(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  run: AgentRun,
): Promise<true> {
  const afterEventId = parseAfterEventId(url);
  if (afterEventId === null) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'afterEventId must be a non-negative safe integer',
    );
    return true;
  }

  const exchange = getRuntimeStorage().runtimeEvents;
  const filter = {
    appId: run.appId,
    runId: run.id,
    afterEventId: afterEventId as never,
    limit: TASK_LIMIT,
  };
  const streaming = req.headers.accept?.includes('text/event-stream') ?? false;
  if (streaming && ctx.state.activeStreams >= ctx.maxConcurrentStreams) {
    sendError(res, 429, 'TOO_MANY_STREAMS', 'Too many active event streams');
    return true;
  }

  const initial = (await exchange.list(filter)).slice(0, TASK_LIMIT);
  if (!streaming) {
    sendJson(res, 200, { events: initial.map(projectInvalidation) });
    return true;
  }

  ctx.state.activeStreams += 1;
  let closed = req.destroyed || res.destroyed;
  let active = true;
  let subscription: ReturnType<typeof exchange.subscribe> | undefined;
  const cleanup = () => {
    if (closed && !active && !subscription) return;
    closed = true;
    subscription?.close();
    subscription = undefined;
    if (active) {
      active = false;
      ctx.state.activeStreams = Math.max(0, ctx.state.activeStreams - 1);
    }
  };
  req.once('close', cleanup);
  res.once('close', cleanup);
  if (closed) {
    cleanup();
    return true;
  }

  const lastEventId = initial.at(-1)?.eventId ?? afterEventId;
  try {
    subscription = exchange.subscribe({
      ...filter,
      afterEventId: lastEventId as never,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  if (closed || req.destroyed || res.destroyed) {
    cleanup();
    return true;
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  try {
    for (const event of initial) {
      await writeActivitySseEvent(
        res,
        projectInvalidation(event),
        () => closed,
      );
    }
  } catch (error) {
    cleanup();
    throw error;
  }

  const pump = async () => {
    while (!closed) {
      try {
        const events = await subscription?.next({ timeoutMs: 30_000 });
        for (const event of events ?? []) {
          await writeActivitySseEvent(
            res,
            projectInvalidation(event),
            () => closed,
          );
        }
      } catch (error) {
        if (closed) return;
        logger.warn({ err: error, runId: run.id }, 'Failed streaming activity');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };
  void pump();
  return true;
}

function parseActivityRoute(
  pathname: string,
): { runId: string; action: 'detail' | 'events' } | null {
  const match = /^\/v1\/activity\/([^/]+)(?:\/(events))?$/.exec(pathname);
  if (!match) return null;
  return {
    runId: decodeURIComponent(match[1]!),
    action: match[2] === 'events' ? 'events' : 'detail',
  };
}

function parseAfterEventId(url: URL): number | null {
  if ([...url.searchParams.keys()].some((key) => key !== 'afterEventId')) {
    return null;
  }
  const values = url.searchParams.getAll('afterEventId');
  if (values.length > 1) return null;
  const raw = values[0] ?? '0';
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function projectRun(run: AgentRun, now: number): ActivityRun {
  return {
    id: run.id,
    agentId: run.agentId,
    cause: run.cause,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
    durationMs: durationMs(run.startedAt ?? run.createdAt, run.endedAt, now),
    resultSummary: run.resultSummary ?? null,
    errorSummary: run.errorSummary ?? null,
  };
}

function projectTaskTree(
  tasks: AsyncTaskRecord[],
  now: number,
): ActivityTask[] {
  const projected = [...tasks]
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .map((task) => ({
      node: projectTask(task, now),
      parentTaskId: nonEmptyString(task.privateCorrelationJson.parentTaskId),
    }));
  const byId = new Map(projected.map((item) => [item.node.id, item.node]));
  const parentById = new Map(
    projected.map((item) => [item.node.id, item.parentTaskId]),
  );
  const roots: ActivityTask[] = [];
  for (const item of projected) {
    const parent = item.parentTaskId ? byId.get(item.parentTaskId) : undefined;
    if (
      !parent ||
      createsParentCycle(item.node.id, item.parentTaskId!, parentById)
    ) {
      roots.push(item.node);
    } else {
      parent.children.push(item.node);
    }
  }
  return roots;
}

function createsParentCycle(
  taskId: string,
  parentTaskId: string,
  parentById: Map<string, string | null>,
): boolean {
  const seen = new Set<string>();
  let current: string | null = parentTaskId;
  while (current) {
    if (current === taskId || seen.has(current)) return true;
    seen.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}

function projectTask(task: AsyncTaskRecord, now: number): ActivityTask {
  const progress = record(task.privateCorrelationJson.progress);
  return {
    id: task.id,
    agentId: task.agentId,
    targetAgentId: nonEmptyString(task.privateCorrelationJson.targetAgentId),
    kind: task.kind,
    status: task.status,
    summary: task.summary ?? null,
    outputSummary: task.outputSummary ?? null,
    errorSummary: task.errorSummary ?? null,
    currentPhase: nonEmptyString(progress.phase),
    lastProgress: nonEmptyString(progress.lastProgress),
    lastToolSummary: nonEmptyString(progress.lastToolSummary),
    blocker: nonEmptyString(progress.blocker),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt ?? null,
    terminalAt: task.terminalAt ?? null,
    durationMs: durationMs(
      task.startedAt ?? task.createdAt,
      task.terminalAt,
      now,
    ),
    children: [],
  };
}

function projectInvalidation(event: RuntimeEvent): ActivityInvalidation {
  return {
    eventId: event.eventId,
    type: event.eventType,
    createdAt: event.createdAt,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function durationMs(
  startedAt: string,
  endedAt: string | undefined | null,
  now: number,
): number | null {
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : null;
}

async function writeActivitySseEvent(
  res: ServerResponse,
  event: ActivityInvalidation,
  isClosed: () => boolean,
): Promise<void> {
  if (isClosed() || res.destroyed) return;
  const chunk = [
    `id: ${event.eventId}`,
    `event: ${sanitizeSseEventType(event.type)}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
  if (res.write(chunk)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res.off('drain', finish);
      res.off('close', finish);
      res.off('error', finish);
      resolve();
    };
    res.once('drain', finish);
    res.once('close', finish);
    res.once('error', finish);
    if (isClosed() || res.destroyed) finish();
  });
}

function sanitizeSseEventType(type: string): string {
  return /^[a-z0-9._-]+$/.test(type) ? type : 'runtime_event';
}
