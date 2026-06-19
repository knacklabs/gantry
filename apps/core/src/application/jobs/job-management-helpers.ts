import type { Job, JobScheduleType } from '../../domain/types.js';
import { appIdFromConversationJid } from '../../shared/app-conversation-jid.js';
import {
  isReservedSystemJobId,
  isReservedSystemJobPrompt,
} from '../../shared/system-job-identity.js';
import { ApplicationError } from '../common/application-error.js';
import type { Clock } from '../common/clock.js';
import type {
  AppSessionRecord,
  JobExecutionContextInput,
  JobNotificationRouteInput,
  JobControlPort,
  JobSchedulePlanner,
  JobUpdatePatch,
  SchedulerJobAccess,
} from './job-management-types.js';

const MAX_QUERY_LIMIT = 1_000;

export interface AuthenticatedJobRouteContext {
  conversationJid: string;
  threadId: string | null;
  workspaceKey: string;
}

export interface JobNotificationRouteApprovalDecision {
  approved: boolean;
  reason?: string;
  approvedConversationJid?: string;
}

export interface JobNotificationRouteApprovalRequest {
  operation: 'create' | 'update';
  jobId: string;
  jobName: string;
  authenticatedContext: AuthenticatedJobRouteContext;
  requestedRoutes: JobNotificationRouteInput[];
  existingRoutes: JobNotificationRouteInput[];
  routesBeyondContext: JobNotificationRouteInput[];
}

export interface JobNotificationRouteApprovalDeps {
  approveJobNotificationRoutes?: (
    input: JobNotificationRouteApprovalRequest,
  ) => Promise<JobNotificationRouteApprovalDecision>;
}

export async function resolveCanonicalAppSessionForOrigin(input: {
  access: SchedulerJobAccess;
  control?: JobControlPort;
}): Promise<{
  originAppId: string | null;
  canonicalSession?: AppSessionRecord;
}> {
  const originAppId = appIdFromConversationJid(
    input.access.originConversationJid,
  );
  if (!originAppId) return { originAppId };
  const canonicalSession = input.control
    ? await input.control.getAppSessionByChatJid(
        input.access.originConversationJid,
      )
    : undefined;
  if (!canonicalSession) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Scheduler jobs from app conversations require a canonical app session.',
    );
  }
  return { originAppId, canonicalSession };
}

export function normalizeScheduleType(raw: unknown): JobScheduleType {
  if (
    raw === 'cron' ||
    raw === 'interval' ||
    raw === 'once' ||
    raw === 'manual'
  ) {
    return raw;
  }
  throw new ApplicationError('INVALID_SCHEDULE', 'Unsupported schedule type.');
}

export function assertPublicJobNamespace(input: {
  jobId?: string | null;
  prompt?: string | null;
}): void {
  if (input.jobId && isReservedSystemJobId(input.jobId)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Job id uses a reserved Gantry system namespace.',
    );
  }
  if (input.prompt && isReservedSystemJobPrompt(input.prompt)) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'Job prompt uses a reserved Gantry system namespace.',
    );
  }
}

export function resolveLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const normalized = Math.floor(raw);
  if (normalized <= 0) return fallback;
  return Math.min(normalized, MAX_QUERY_LIMIT);
}

export function normalizeExecutionContext(
  value: JobExecutionContextInput,
): JobExecutionContextInput {
  const conversationJid =
    typeof value.conversationJid === 'string'
      ? value.conversationJid.trim()
      : '';
  const workspaceKey =
    typeof value.workspaceKey === 'string' ? value.workspaceKey.trim() : '';
  const threadId = normalizeNullableString(value.threadId);
  const sessionId = normalizeNullableOptionalString(value.sessionId);
  if (!conversationJid || !workspaceKey || threadId === undefined) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'executionContext requires conversationJid, workspaceKey, and threadId.',
    );
  }
  return {
    conversationJid,
    workspaceKey,
    threadId,
    ...(value.sessionId !== undefined ? { sessionId } : {}),
  };
}

export function authenticatedContextFromAccess(
  access: SchedulerJobAccess,
  workspaceKey: string,
): AuthenticatedJobRouteContext {
  const conversationJid = access.originConversationJid.trim();
  if (!conversationJid) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Scheduler job access requires an originating conversation.',
    );
  }
  return {
    conversationJid,
    workspaceKey,
    threadId: normalizeNullableOptionalString(access.authThreadId) ?? null,
  };
}

export function assertExecutionContextMatchesAuthenticatedContext(input: {
  executionContext?: JobExecutionContextInput;
  authenticatedContext: AuthenticatedJobRouteContext;
  enforceThread?: boolean;
}): JobExecutionContextInput {
  const expected = input.authenticatedContext;
  const provided =
    input.executionContext !== undefined
      ? normalizeExecutionContext(input.executionContext)
      : expected;
  if (provided.conversationJid !== expected.conversationJid) {
    throw new ApplicationError(
      'FORBIDDEN',
      'executionContext conversation must match authenticated conversation.',
    );
  }
  if (provided.workspaceKey !== expected.workspaceKey) {
    throw new ApplicationError(
      'FORBIDDEN',
      'executionContext workspaceKey must match the authenticated workspace key.',
    );
  }
  if (
    input.enforceThread !== false &&
    (provided.threadId ?? null) !== (expected.threadId ?? null)
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'executionContext threadId must match authenticated thread binding.',
    );
  }
  return provided;
}

export function normalizeNotificationRoutes(
  routes: readonly JobNotificationRouteInput[],
): JobNotificationRouteInput[] {
  const normalized: JobNotificationRouteInput[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const conversationJid =
      typeof route.conversationJid === 'string'
        ? route.conversationJid.trim()
        : '';
    const label = typeof route.label === 'string' ? route.label.trim() : '';
    const threadId = normalizeNullableString(route.threadId);
    if (!conversationJid || !label || threadId === undefined) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'notificationRoutes entries require conversationJid, threadId, and label.',
      );
    }
    const dedupeKey = `${conversationJid}\u0000${threadId ?? ''}\u0000${label}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ conversationJid, threadId, label });
  }
  if (normalized.length === 0) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      'notificationRoutes must include at least one route.',
    );
  }
  return normalized;
}

export function normalizeStoredNotificationRoutes(
  routes: readonly JobNotificationRouteInput[] | undefined,
): JobNotificationRouteInput[] {
  if (!routes || routes.length === 0) return [];
  const normalized: JobNotificationRouteInput[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const conversationJid =
      typeof route?.conversationJid === 'string'
        ? route.conversationJid.trim()
        : '';
    const label = typeof route?.label === 'string' ? route.label.trim() : '';
    const threadId = normalizeNullableString(route?.threadId);
    if (!conversationJid || !label || threadId === undefined) continue;
    const dedupeKey = `${conversationJid}\u0000${threadId ?? ''}\u0000${label}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ conversationJid, threadId, label });
  }
  return normalized;
}

export function routesBeyondAuthenticatedContext(input: {
  routes: readonly JobNotificationRouteInput[];
  authenticatedContext: AuthenticatedJobRouteContext;
}): JobNotificationRouteInput[] {
  const { routes, authenticatedContext } = input;
  return routes.filter(
    (route) =>
      route.conversationJid !== authenticatedContext.conversationJid ||
      (route.threadId ?? null) !== (authenticatedContext.threadId ?? null),
  );
}

export async function requireJobNotificationRouteApproval(input: {
  deps: JobNotificationRouteApprovalDeps;
  request: JobNotificationRouteApprovalRequest;
}): Promise<void> {
  if (input.request.routesBeyondContext.length === 0) return;
  if (!input.deps.approveJobNotificationRoutes) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Cross-conversation notification routes require same-conversation approval before they can be stored.',
    );
  }
  const decision = await input.deps.approveJobNotificationRoutes(input.request);
  if (!decision.approved) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Notification route approval denied: ${decision.reason || 'not approved'}.`,
    );
  }
  if (
    decision.approvedConversationJid !==
    input.request.authenticatedContext.conversationJid
  ) {
    throw new ApplicationError(
      'FORBIDDEN',
      'Notification route approval must be granted from the originating conversation.',
    );
  }
}

export function buildJobUpdates(
  job: Job,
  patch: JobUpdatePatch,
  planner: JobSchedulePlanner,
  clock: Clock,
): Partial<Job> {
  const updates: Partial<Job> = {};
  if (patch.name !== undefined)
    updates.name = requireNonEmpty(patch.name, 'name');
  if (patch.prompt !== undefined) {
    updates.prompt = requireNonEmpty(patch.prompt, 'prompt');
  }
  if (patch.model !== undefined) updates.model = patch.model;
  if (patch.workspaceKey !== undefined) {
    updates.workspace_key = requireNonEmpty(patch.workspaceKey, 'workspaceKey');
  }
  if (patch.threadId !== undefined) {
    updates.thread_id = patch.threadId
      ? requireNonEmpty(patch.threadId, 'threadId')
      : null;
  }
  if (patch.executionContext !== undefined) {
    const executionContext = normalizeExecutionContext(patch.executionContext);
    updates.execution_context = executionContext;
    updates.thread_id = executionContext.threadId;
  }
  if (patch.notificationRoutes !== undefined) {
    const notificationRoutes = normalizeNotificationRoutes(
      patch.notificationRoutes,
    );
    updates.notification_routes = notificationRoutes;
  }
  if (patch.accessRequirements !== undefined) {
    updates.access_requirements = patch.accessRequirements;
  }
  if (patch.silent !== undefined) updates.silent = patch.silent;
  if (patch.cleanupAfterMs !== undefined)
    updates.cleanup_after_ms = patch.cleanupAfterMs;
  if (patch.timeoutMs !== undefined) updates.timeout_ms = patch.timeoutMs;
  if (patch.maxRetries !== undefined) updates.max_retries = patch.maxRetries;
  if (patch.retryBackoffMs !== undefined)
    updates.retry_backoff_ms = patch.retryBackoffMs;
  if (patch.maxConsecutiveFailures !== undefined) {
    updates.max_consecutive_failures = patch.maxConsecutiveFailures;
  }
  if (patch.scheduleType !== undefined)
    updates.schedule_type = patch.scheduleType;
  if (patch.scheduleValue !== undefined)
    updates.schedule_value = patch.scheduleValue;
  const merged = { ...job, ...updates };
  if (
    updates.schedule_type !== undefined ||
    updates.schedule_value !== undefined
  ) {
    if (merged.schedule_type === 'manual') {
      updates.next_run = null;
    } else {
      updates.next_run = planner.planInitial({
        scheduleType: merged.schedule_type,
        scheduleValue: merged.schedule_value,
      }).nextRun;
    }
  }
  if (patch.status === 'paused') {
    updates.status = 'paused';
    updates.pause_reason = 'Paused by SDK';
    updates.next_run = null;
  } else if (patch.status === 'active') {
    const nextRun = planner.planResume({ job: merged, clock });
    if (nextRun === undefined) {
      throw new ApplicationError(
        'INVALID_SCHEDULE',
        'Cannot resume scheduler job due to invalid schedule.',
      );
    }
    updates.status = 'active';
    updates.pause_reason = null;
    updates.next_run = nextRun;
  }
  return updates;
}

export function encodeTriggerRequester(input: {
  appId: string;
  sessionId: string;
}): string {
  return JSON.stringify({
    kind: 'sdk',
    appId: input.appId,
    sessionId: input.sessionId,
  });
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApplicationError('INVALID_REQUEST', `${field} cannot be empty`);
  }
  return trimmed;
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNullableOptionalString(
  value: unknown,
): string | null | undefined {
  if (value === undefined) return undefined;
  return normalizeNullableString(value);
}
