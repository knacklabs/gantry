import { createHash } from 'node:crypto';

import type { Job, RegisteredGroup } from '../../domain/types.js';
import type { JobVisibilityMetadata } from '../../application/jobs/job-visibility-metadata.js';
import type { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';
import { nowIso as runtimeNowIso } from '../../infrastructure/time/datetime.js';
import { resolveAppScopeAppId as applicationResolveAppScopeAppId } from '../../application/app-scope/resolve-app-scope.js';
import { jobBelongsToApp as applicationJobBelongsToApp } from '../../application/jobs/job-access.js';
import { resolveJobRuntimeAppId as applicationResolveJobRuntimeAppId } from '../../application/jobs/job-access.js';
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
}): RegisteredGroup {
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

export function jobBelongsToApp(job: Job, appId: string): boolean {
  return applicationJobBelongsToApp(job, appId);
}

export function resolveJobRuntimeAppId(job: Job): string {
  return applicationResolveJobRuntimeAppId(job);
}

export async function resolveJobAppSession(
  control: ReturnType<typeof getRuntimeControlRepository>,
  job: Job,
  appId: string,
) {
  for (const chatJid of Array.isArray(job.linked_sessions)
    ? job.linked_sessions
    : []) {
    if (!chatJid.startsWith(`app:${appId}:`)) continue;
    const session = await control.getAppSessionByChatJid(chatJid);
    if (session?.appId === appId) return session;
  }
  return undefined;
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
  metadata?: JobVisibilityMetadata,
  options: { detail?: boolean } = { detail: true },
): Record<string, unknown> {
  const isManual = job.schedule_type === 'manual';
  const resolvedModel = resolveModelSelection(job.model);
  const detail = options.detail !== false;
  return {
    jobId: job.id,
    name: job.name,
    ...(detail ? { prompt: job.prompt } : {}),
    promptPreview: metadata?.promptPreview ?? previewPrompt(job.prompt),
    ...(detail ? { fullPrompt: metadata?.fullPrompt ?? job.prompt } : {}),
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
    staleness: metadata?.staleness ?? null,
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
    target: metadata?.target ?? {
      appId: resolveJobRuntimeAppId(job),
      agentId: job.group_scope.startsWith('agent:')
        ? job.group_scope
        : `agent:${job.group_scope}`,
      groupScope: job.group_scope,
      conversationJids: job.linked_sessions,
      threadId: job.thread_id,
    },
    notificationTarget: metadata?.notificationTarget ?? {
      linkedSessions: job.linked_sessions,
      threadId: job.thread_id,
      silent: job.silent,
    },
    ...(detail
      ? {
          inheritedTools: metadata?.inheritedTools ?? [],
          jobExtraTools:
            metadata?.jobExtraTools ??
            job.capability_policy?.allowed_tools ??
            [],
          effectiveAllowedTools:
            metadata?.effectiveAllowedTools ??
            job.capability_policy?.allowed_tools ??
            [],
          recentRunErrors: metadata?.recentRunErrors ?? [],
        }
      : {
          inheritedToolCount: metadata?.inheritedToolCount ?? 0,
          jobExtraToolCount:
            metadata?.jobExtraToolCount ??
            job.capability_policy?.allowed_tools?.length ??
            0,
          effectiveAllowedToolCount:
            metadata?.effectiveAllowedToolCount ??
            job.capability_policy?.allowed_tools?.length ??
            0,
        }),
  };
}

function previewPrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}
