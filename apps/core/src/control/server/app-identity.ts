import { createHash } from 'node:crypto';

import type { Job, ConversationRoute } from '../../domain/types.js';
import type { JobVisibilityMetadata } from '../../application/jobs/job-visibility-metadata.js';
import type { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';
import { nowIso as runtimeNowIso } from '../../shared/time/datetime.js';
import { resolveAppScopeAppId as applicationResolveAppScopeAppId } from '../../application/app-scope/resolve-app-scope.js';
import type { AppSessionRecord as JobAppSessionRecord } from '../../application/jobs/job-management-types.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import {
  modelUseKindForJobSchedule,
  resolveJobModel,
} from '../../application/jobs/job-model-resolution.js';
import type { ApiKeyRecord } from './auth.js';
import type { ControlRouteContext } from './handler-context.js';

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

export function mapManualJobToStored(
  job: Job,
  metadata: JobVisibilityMetadata,
  options: {
    detail?: boolean;
    getDefaultModelConfig?: ControlRouteContext['getDefaultModelConfig'];
  } = { detail: true },
): Record<string, unknown> {
  const isManual = job.schedule_type === 'manual';
  const modelUseKind = modelUseKindForJobSchedule(job.schedule_type);
  const defaultConfig = options.getDefaultModelConfig?.(
    modelUseKind,
    job.group_scope,
  ) ?? {
    model: job.model ?? undefined,
    source: job.model ? 'job.model' : 'inherited',
  };
  const resolvedModel = resolveJobModel(job, defaultConfig);
  const resolvedAlias = resolvedModel.resolution?.ok
    ? resolvedModel.resolution.alias
    : (resolvedModel.selectedModel ?? null);
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
    executionContext: metadata.executionContext,
    notificationRoutes: metadata.notificationRoutes,
    capabilityRequirements: job.capability_requirements ?? [],
    toolAccessRequirements: job.tool_access_requirements ?? [],
    requiredMcpServers: job.required_mcp_servers ?? [],
    setup: metadata.setup,
    nextRun: job.next_run,
    lastRun: job.last_run,
    staleness: metadata.staleness,
    health: metadata.health,
    modelAlias: job.model ?? null,
    modelSelection: {
      alias: resolvedAlias,
      source: job.model ? 'explicit' : resolvedModel.source,
      explicit: Boolean(job.model),
    },
    model: resolvedModel.entry
      ? {
          displayName: resolvedModel.entry.displayName,
          responseFamily: resolvedModel.entry.responseFamily,
          modelRoute: {
            id: resolvedModel.entry.modelRoute.id,
            label: resolvedModel.entry.modelRoute.label,
          },
          contextWindowTokens: resolvedModel.entry.contextWindowTokens,
          maxOutputTokens: resolvedModel.entry.maxOutputTokens,
          cachePolicy: resolvedModel.entry.cacheMode,
        }
      : null,
    groupScope: job.group_scope,
    sessionId: job.session_id,
    target: metadata.target,
    toolAccess: metadata.toolAccess,
    ...(detail
      ? {
          recentRunErrors: metadata.recentRunErrors,
        }
      : {}),
  };
}
