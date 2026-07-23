import { createHash } from 'node:crypto';

import type {
  JobExecutionContext,
  JobNotificationRoute,
} from '../domain/types.js';

export const JOB_NOTIFICATION_START_PROFILE_ID = 'job.notification.start.v1';
export const JOB_NOTIFICATION_SUMMARY_PROFILE_ID =
  'job.notification.summary.v1';

export type JobNotificationPhase = 'start' | 'summary';

export interface NormalizedJobNotificationRoute {
  conversationJid: string;
  threadId: string | null;
  providerAccountId?: string;
  label: string;
}

export interface JobNotificationRouteSource {
  notification_routes?: readonly JobNotificationRoute[] | null;
  notificationRoutes?: readonly JobNotificationRoute[] | null;
  execution_context?: JobExecutionContext | null;
  executionContext?: JobExecutionContext | null;
}

export function resolveJobNotificationRoutes(
  source: JobNotificationRouteSource,
): NormalizedJobNotificationRoute[] {
  const explicitRoutes = dedupeRoutes(
    normalizeRoutes(
      source.notification_routes ?? source.notificationRoutes ?? [],
    ),
  );
  if (explicitRoutes.length > 0) return explicitRoutes;
  const fallback = executionContextToRoute(
    source.execution_context ?? source.executionContext,
  );
  return fallback ? [fallback] : [];
}

export function profileIdForJobNotificationPhase(
  phase: JobNotificationPhase,
): string {
  return phase === 'start'
    ? JOB_NOTIFICATION_START_PROFILE_ID
    : JOB_NOTIFICATION_SUMMARY_PROFILE_ID;
}

export function buildJobNotificationIdempotencyKey(input: {
  jobId: string;
  runId?: string | null;
  phase: JobNotificationPhase;
  route: Pick<
    NormalizedJobNotificationRoute,
    'conversationJid' | 'threadId' | 'providerAccountId'
  >;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 'v1',
        jobId: input.jobId,
        runId: normalizeOptional(input.runId) ?? null,
        phase: input.phase,
        conversationJid: input.route.conversationJid,
        threadId: input.route.threadId,
        providerAccountId: input.route.providerAccountId ?? null,
      }),
      'utf8',
    )
    .digest('hex')
    .slice(0, 40);
  return `job.notification:${input.phase}:${digest}`;
}

export function buildCanonicalJobLifecycleTarget(input: {
  conversationJid: string;
  threadId?: string | null;
  workspaceKey: string;
  sessionId?: string | null;
  label?: string;
}): {
  executionContext: JobExecutionContext;
  notificationRoutes: JobNotificationRoute[];
} {
  const conversationJid = normalizeOptional(input.conversationJid);
  const workspaceKey = normalizeOptional(input.workspaceKey);
  if (!conversationJid || !workspaceKey) {
    throw new Error(
      'Canonical job lifecycle target requires conversationJid and workspaceKey.',
    );
  }
  const threadId = normalizeOptional(input.threadId) ?? null;
  const executionContext: JobExecutionContext = {
    conversationJid,
    threadId,
    workspaceKey,
    sessionId: normalizeOptional(input.sessionId) ?? null,
  };
  return {
    executionContext,
    notificationRoutes: [
      {
        conversationJid,
        threadId,
        label: normalizeOptional(input.label) ?? 'Primary',
      },
    ],
  };
}

function normalizeRoutes(
  routes: readonly JobNotificationRoute[],
): NormalizedJobNotificationRoute[] {
  const normalized: NormalizedJobNotificationRoute[] = [];
  for (const route of routes) {
    const conversationJid = normalizeOptional(route?.conversationJid);
    if (!conversationJid) continue;
    normalized.push({
      conversationJid,
      threadId: normalizeOptional(route?.threadId) ?? null,
      providerAccountId: normalizeOptional(route?.providerAccountId),
      label: normalizeOptional(route?.label) ?? conversationJid,
    });
  }
  return normalized;
}

function dedupeRoutes(
  routes: readonly NormalizedJobNotificationRoute[],
): NormalizedJobNotificationRoute[] {
  const seen = new Set<string>();
  const unique: NormalizedJobNotificationRoute[] = [];
  for (const route of routes) {
    const key = `${route.conversationJid}\u0000${route.threadId ?? ''}\u0000${route.providerAccountId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(route);
  }
  return unique;
}

function executionContextToRoute(
  context: JobExecutionContext | null | undefined,
): NormalizedJobNotificationRoute | null {
  if (!context) return null;
  const conversationJid = normalizeOptional(context.conversationJid);
  if (!conversationJid) return null;
  return {
    conversationJid,
    threadId: normalizeOptional(context.threadId) ?? null,
    label: 'Primary',
  };
}

function normalizeOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
