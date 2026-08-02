import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { createRuntimeBrainService } from '../../../brain/brain-runtime.js';
import {
  buildDigestPreview,
  digestPrefetchLimit,
} from '../../../brain/observer-digest.js';
import { MessageInsightFreshnessProbe } from '../../../brain/observer-evidence-freshness.js';
import {
  resolveObserverDeliveryStatus,
  resolveObserverOwnerRoute,
} from '../../../config/settings/observer-activation.js';
import type { RuntimeSettings } from '../../../config/settings/runtime-settings-types.js';
import {
  OBSERVER_INSIGHT_TYPES,
  OBSERVER_INSIGHT_STATES,
  isObserverSubjectKey,
  type ObserverInsightState,
  type ObserverInsightType,
  type ObserverSubjectKey,
} from '../../../domain/ports/observer-insights.js';
import { canAccessApp } from '../app-identity.js';
import { isValidControlId, type ApiKeyRecord } from '../auth.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function assertAppAccess(
  res: ServerResponse,
  appId: string,
  auth: ApiKeyRecord,
): boolean {
  if (!isValidControlId(appId)) {
    sendError(res, 400, 'INVALID_REQUEST', 'appId is invalid');
    return false;
  }
  if (!canAccessApp(auth, appId)) {
    sendError(res, 403, 'FORBIDDEN', 'API key cannot access this app');
    return false;
  }
  return true;
}

function readLimit(res: ServerResponse, url: URL): number | null {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
    return null;
  }
  return value;
}

function readState(
  res: ServerResponse,
  url: URL,
): ObserverInsightState | null | undefined {
  const raw = url.searchParams.get('state');
  if (raw === null) return undefined;
  if (!OBSERVER_INSIGHT_STATES.includes(raw as ObserverInsightState)) {
    sendError(res, 400, 'INVALID_REQUEST', 'state is invalid');
    return null;
  }
  return raw as ObserverInsightState;
}

function readType(
  res: ServerResponse,
  url: URL,
): ObserverInsightType | null | undefined {
  const raw = url.searchParams.get('type');
  if (raw === null) return undefined;
  if (!OBSERVER_INSIGHT_TYPES.includes(raw as ObserverInsightType)) {
    sendError(res, 400, 'INVALID_REQUEST', 'type is invalid');
    return null;
  }
  return raw as ObserverInsightType;
}

interface ObserverListCursor {
  createdAt: string;
  id: string;
}

function decodeCursor(
  res: ServerResponse,
  raw: string | null,
): ObserverListCursor | null | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    sendError(res, 400, 'INVALID_REQUEST', 'cursor is invalid');
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
    typeof (parsed as { id?: unknown }).id !== 'string' ||
    (parsed as { id: string }).id.length === 0 ||
    !Number.isFinite(Date.parse((parsed as { createdAt: string }).createdAt))
  ) {
    sendError(res, 400, 'INVALID_REQUEST', 'cursor is invalid');
    return null;
  }
  return parsed as ObserverListCursor;
}

function encodeCursor(cursor: ObserverListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export async function handleObserverRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/v1/observer')) return false;

  // Preview is a POST dry-run; every other observer route is GET. All read-only,
  // so all authorize with the same memory:read scope.
  if (pathname === '/v1/observer/preview') {
    if (req.method !== 'POST') return false;
  } else if (req.method !== 'GET') {
    return false;
  }
  const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:read']);
  if (!auth) return true;
  const appId = url.searchParams.get('appId') || auth.appId;
  if (!assertAppAccess(res, appId, auth)) return true;

  const repositories = getRuntimeStorage().repositories;
  const repository = repositories.observerInsights;

  if (pathname === '/v1/observer/status') {
    const status = await ctx.resolveObserverStatus(appId as never);
    const brain = createRuntimeBrainService(appId);
    const [brainStatus, insights, pendingInsights] = await Promise.all([
      brain.status(appId),
      repository.count({ appId }),
      repository.count({ appId, state: 'pending' }),
    ]);
    sendJson(res, 200, {
      ...status,
      counts: {
        evidence: brainStatus.channelPages,
        insights,
        pendingInsights,
      },
    });
    return true;
  }

  if (pathname === '/v1/observer/insights') {
    const limit = readLimit(res, url);
    if (limit === null) return true;
    const insightType = readType(res, url);
    if (insightType === null) return true;
    const state = readState(res, url);
    if (state === null) return true;
    const before = decodeCursor(res, url.searchParams.get('cursor'));
    if (before === null) return true;
    const rawSubject = url.searchParams.get('subject')?.trim();
    if (rawSubject && !isObserverSubjectKey(rawSubject)) {
      sendError(res, 400, 'INVALID_REQUEST', 'subject is invalid');
      return true;
    }
    const subject = rawSubject as ObserverSubjectKey | undefined;
    const rows = await repository.list({
      appId,
      subject,
      insightType,
      state,
      limit: limit + 1,
      before,
    });
    const insights = rows.slice(0, limit);
    const last = insights.at(-1);
    sendJson(res, 200, {
      insights,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    });
    return true;
  }

  if (pathname === '/v1/observer/preview') {
    // Dry-run: compute the would-be digest WITHOUT claiming, reserving, or
    // sending. Reads the pending pool with listPendingForDigest (never the
    // claiming variant) and buildDigestPreview, both write-free.
    const settings = ctx.getInternalRuntimeSettings() as RuntimeSettings;
    const status = resolveObserverDeliveryStatus(settings);
    if (!status.eligible) {
      sendJson(res, 200, {
        eligible: false,
        reason: status.reason,
        message: status.message,
      });
      return true;
    }
    const candidates = await repository.listPendingForDigest({
      appId,
      recipient: status.owner.recipient,
      limit: digestPrefetchLimit(status.schedule.maxInsights),
      nowIso: new Date().toISOString(),
    });
    const freshnessProbe = new MessageInsightFreshnessProbe(
      getRuntimeStorage().ops,
    );
    const preview = await buildDigestPreview({
      nowIso: new Date().toISOString(),
      timezone: status.schedule.timezone,
      maxInsights: status.schedule.maxInsights,
      candidates,
      freshnessProbe,
    });
    sendJson(res, 200, {
      eligible: true,
      recipient: status.owner.recipient,
      localDay: preview.localDay,
      renderedDigest: preview.renderedDigest,
      skippedReason: preview.skippedReason,
      selected: preview.selected.map((insight) => ({
        id: insight.id,
        subject: insight.subject,
        insightType: insight.insightType,
        title: insight.title,
        summary: insight.summary,
        confidence: insight.confidence,
        priorityScore: insight.priorityScore,
      })),
    });
    return true;
  }

  if (pathname === '/v1/observer/deliveries') {
    const limit = readLimit(res, url);
    if (limit === null) return true;
    // History is owner-scoped; if no owner is configured there is nothing to
    // list. resolveObserverOwnerRoute needs only observer.owner + its DM, so
    // history stays visible even when delivery is currently disabled.
    const owner = resolveObserverOwnerRoute(
      ctx.getInternalRuntimeSettings() as RuntimeSettings,
    );
    if (!owner.ok) {
      sendJson(res, 200, { recipient: null, deliveries: [] });
      return true;
    }
    const deliveries = await repository.listDigestDeliveries({
      appId,
      recipient: owner.owner.recipient,
      limit,
    });
    sendJson(res, 200, { recipient: owner.owner.recipient, deliveries });
    return true;
  }

  return false;
}
