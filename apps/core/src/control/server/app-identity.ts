import { createHash } from 'node:crypto';

import type { Job, ConversationRoute } from '../../domain/types.js';
import type { JobVisibilityMetadata } from '../../application/jobs/job-visibility-metadata.js';
import type { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';
import { nowIso as runtimeNowIso } from '../../infrastructure/time/datetime.js';
import { resolveAppScopeAppId as applicationResolveAppScopeAppId } from '../../application/app-scope/resolve-app-scope.js';
import type { AppSessionRecord as JobAppSessionRecord } from '../../application/jobs/job-management-types.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import { resolveModelSelection } from '../../shared/model-catalog.js';
import type { ApiKeyRecord } from './auth.js';

export function nowIso(): IsoTimestamp {
  return runtimeNowIso() as IsoTimestamp;
}

function sanitizeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

export function makeAppGroup(input: {
  appId: string;
  conversationId: string;
  chatJid: string;
}): ConversationRoute {
  const app = sanitizeSegment(input.appId) || 'app';
  const conversation = sanitizeSegment(input.conversationId) || 'session';
  const identityHash = createHash('sha256')
    .update(`${input.appId}\0${input.conversationId}`)
    .digest('hex')
    .slice(0, 12);
  const prefix = `app_${identityHash}_`;
  const remaining = 96 - prefix.length;
  const appPart = app.slice(0, Math.max(8, Math.floor(remaining * 0.4)));
  const conversationPart = conversation.slice(
    0,
    Math.max(8, remaining - appPart.length - 1),
  );
  return {
    name: `${input.appId}:${input.conversationId}`,
    folder: `${prefix}${appPart}_${conversationPart}`.slice(0, 96),
    trigger: '',
    added_at: nowIso(),
    requiresTrigger: false,
    isMain: false,
  };
}

export function canAccessApp(
  auth: ApiKeyRecord,
  appId: string | null | undefined,
): boolean {
  if (!appId) return false;
  return auth.appId === appId;
}

export function resolveAppScopeAppId(
  auth: ApiKeyRecord,
  assertedAppId: string | null | undefined,
): string | null {
  return applicationResolveAppScopeAppId({
    apiKeyAppId: auth.appId,
    assertedAppId,
  });
}

export async function resolveJobAppSession(
  control: ReturnType<typeof getRuntimeControlRepository>,
  job: Job,
  appId: string,
) {
  if (!job.session_id) return undefined;
  const session = await control.getAppSessionById(job.session_id);
  if (session?.appId !== appId) return undefined;
  return {
    sessionId: session.sessionId,
    appId: session.appId,
    conversationJid: session.chatJid,
    workspaceKey: session.workspaceKey,
    defaultResponseMode: session.defaultResponseMode,
    defaultWebhookId: session.defaultWebhookId,
  } satisfies JobAppSessionRecord;
}

export async function filterJobsByAppSession(
  control: ReturnType<typeof getRuntimeControlRepository>,
  jobs: readonly Job[],
  appId: string,
): Promise<Job[]> {
  const sessionIds = Array.from(
    new Set(
      jobs
        .map((job) => job.session_id?.trim())
        .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ),
  );
  if (sessionIds.length === 0) return [];
  const sessions = await control.getAppSessionsByIds(sessionIds);
  const allowedSessionIds = new Set(
    sessions
      .filter((session) => session.appId === appId)
      .map((session) => session.sessionId),
  );
  return jobs.filter((job) =>
    job.session_id ? allowedSessionIds.has(job.session_id) : false,
  );
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

export async function resolveOwnedWebhookId(
  control: ReturnType<typeof getRuntimeControlRepository>,
  appId: string,
  rawWebhookId: string | null,
): Promise<string | null> {
  const webhookId = rawWebhookId?.trim();
  if (!webhookId) return null;
  const webhook = await control.getWebhookById(webhookId, appId);
  if (!webhook) {
    throw Object.assign(new Error('Webhook not found'), {
      code: 'WEBHOOK_NOT_FOUND',
      statusCode: 404,
    });
  }
  return webhook.webhookId;
}

export function mapManualJobToStored(
  job: Job,
  metadata: JobVisibilityMetadata,
  options: { detail?: boolean } = { detail: true },
): Record<string, unknown> {
  const isManual = job.schedule_type === 'manual';
  const resolvedModel = resolveModelSelection(job.model);
  const detail = options.detail !== false;
  return {
    jobId: job.id,
    name: job.name,
    ...(detail ? { prompt: job.prompt } : {}),
    promptPreview: metadata.promptPreview,
    ...(detail ? { fullPrompt: metadata.fullPrompt ?? job.prompt } : {}),
    kind: isManual
      ? 'manual'
      : job.schedule_type === 'once'
        ? 'once'
        : 'recurring',
    status: job.status,
    schedule: isManual
      ? null
      : job.schedule_type === 'once'
        ? { type: 'once', runAt: job.schedule_value }
        : {
            type: job.schedule_type,
            value: job.schedule_value,
          },
    linkedSessions: job.linked_sessions,
    nextRun: job.next_run,
    lastRun: job.last_run,
    staleness: metadata.staleness,
    executionMode: job.execution_mode,
    modelAlias: job.model ?? null,
    modelProfileId: resolvedModel.ok ? resolvedModel.entry.id : null,
    model: resolvedModel.ok
      ? {
          displayName: resolvedModel.entry.displayName,
          provider: resolvedModel.entry.providerLabel,
          contextWindowTokens: resolvedModel.entry.contextWindowTokens,
          maxOutputTokens: resolvedModel.entry.maxOutputTokens,
          cachePolicy: resolvedModel.entry.cacheMode,
          modelProfileId: resolvedModel.entry.id,
        }
      : null,
    threadId: job.thread_id,
    groupScope: job.group_scope,
    sessionId: job.session_id,
    target: metadata.target,
    notificationTarget: metadata.notificationTarget,
    toolAccess: metadata.toolAccess,
    ...(detail
      ? {
          recentRunErrors: metadata.recentRunErrors,
        }
      : {}),
  };
}
