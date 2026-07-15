import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { AppMemoryService } from '../../../memory/app-memory-service.js';
import {
  processMemoryReviewDecisionRequest,
  processPendingMemoryReviewRequest,
} from '../../../memory/memory-review-ipc.js';
import type {
  AppMemorySearchInput,
  DeleteAppMemoryInput,
  DreamingTriggerInput,
  MemorySubjectType,
  NormalizedMemorySubject,
  PatchAppMemoryInput,
  SaveAppMemoryInput,
} from '../../../memory/memory-types.js';
import { canAccessApp } from '../app-identity.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import { isValidControlId, type ApiKeyRecord } from '../auth.js';

const DIRECT_SAVE_MEMORY_KINDS = new Set([
  'preference',
  'decision',
  'fact',
  'correction',
  'constraint',
]);

function parseMemoryId(pathname: string): string | null {
  const match = /^\/v1\/memory\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

const MEMORY_SUBJECT_TYPES = new Set<MemorySubjectType>([
  'user',
  'group',
  'channel',
  'common',
]);

function isMemorySubjectType(value: unknown): value is MemorySubjectType {
  return (
    typeof value === 'string' &&
    MEMORY_SUBJECT_TYPES.has(value as MemorySubjectType)
  );
}

function parseReviewDecisionPath(pathname: string): string | null {
  const match = /^\/v1\/memory\/reviews\/([^/]+)\/decision$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function parseReviewDetailPath(pathname: string): string | null {
  const match = /^\/v1\/memory\/reviews\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function parseReviewPagingNumber(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  // The service clamps limit/offset to sane bounds; drop only non-numbers here.
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/**
 * Resolve the pending-review subject boundary for review routes. appId defaults
 * to the key's bound app (app-access checked); agentId/subjectType/subjectId are
 * REQUIRED — reviews are always scoped to one subject. Returns null after
 * sending the error response when access is denied or a param is missing.
 */
function readReviewSubject(
  res: ServerResponse,
  url: URL,
  auth: ApiKeyRecord,
): NormalizedMemorySubject | null {
  const appId = url.searchParams.get('appId') || auth.appId;
  if (!assertAppAccess(res, appId, auth)) return null;
  const agentId = url.searchParams.get('agentId')?.trim();
  const subjectType = url.searchParams.get('subjectType')?.trim();
  const subjectId = url.searchParams.get('subjectId')?.trim();
  if (!agentId || !subjectId || !isMemorySubjectType(subjectType)) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'agentId, subjectType (user|group|channel|common), and subjectId are required',
    );
    return null;
  }
  return { appId, agentId, subjectType, subjectId };
}

function readAppId(input: Record<string, unknown>, fallback: string): string {
  return typeof input.appId === 'string' && input.appId.trim()
    ? input.appId.trim()
    : fallback;
}

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

function searchInputFromQuery(url: URL, appId: string): AppMemorySearchInput {
  const subjectTypes = url.searchParams.getAll('subjectType');
  const limit = Number(url.searchParams.get('limit') || 20);
  return {
    appId,
    agentId: url.searchParams.get('agentId') || undefined,
    personId: url.searchParams.get('personId') || undefined,
    groupId: url.searchParams.get('groupId') || undefined,
    channelId: url.searchParams.get('channelId') || undefined,
    threadId: url.searchParams.get('threadId') || undefined,
    query: url.searchParams.get('q') || undefined,
    limit: Number.isFinite(limit) ? limit : 20,
    includeCommon: url.searchParams.get('includeCommon') !== 'false',
    subjectTypes:
      subjectTypes.length > 0
        ? (subjectTypes as AppMemorySearchInput['subjectTypes'])
        : undefined,
  };
}

function sendMemoryDisabled(res: ServerResponse): void {
  sendError(
    res,
    409,
    'MEMORY_DISABLED',
    'Memory is disabled in runtime settings',
  );
}

function validateDirectSaveKind(
  res: ServerResponse,
  input: Record<string, unknown>,
): boolean {
  if (
    !Object.prototype.hasOwnProperty.call(input, 'kind') ||
    (typeof input.kind === 'string' && DIRECT_SAVE_MEMORY_KINDS.has(input.kind))
  ) {
    return true;
  }
  sendError(
    res,
    400,
    'INVALID_REQUEST',
    'memory kind must be one of preference, decision, fact, correction, or constraint',
  );
  return false;
}

function toPublicMemoryItem<T extends { userId?: string | null }>(item: T) {
  const { userId, ...publicItem } = item;
  return userId ? { ...publicItem, personId: userId } : publicItem;
}

export async function handleMemoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/v1/memory')) return false;

  const service = AppMemoryService.getInstance();

  if (pathname === '/v1/memory' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:admin']);
    if (!auth) return true;
    if (!service.isEnabled()) {
      sendMemoryDisabled(res);
      return true;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    const appId = readAppId(body, auth.appId);
    if (!assertAppAccess(res, appId, auth)) return true;
    if (!validateDirectSaveKind(res, body)) return true;
    const saved = await service.save({
      ...(body as unknown as SaveAppMemoryInput),
      appId,
      isAdminWrite: auth.scopes.has('memory:admin'),
    });
    sendJson(res, 201, { memory: toPublicMemoryItem(saved) });
    return true;
  }

  if (pathname === '/v1/memory' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:read']);
    if (!auth) return true;
    const appId = url.searchParams.get('appId') || auth.appId;
    if (!assertAppAccess(res, appId, auth)) return true;
    const memories = await service.list(searchInputFromQuery(url, appId));
    sendJson(res, 200, { memories: memories.map(toPublicMemoryItem) });
    return true;
  }

  if (pathname === '/v1/memory/search' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:read']);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const appId = readAppId(body, auth.appId);
    if (!assertAppAccess(res, appId, auth)) return true;
    const results = await service.search({
      ...(body as unknown as AppMemorySearchInput),
      appId,
    });
    sendJson(res, 200, {
      results: results.map((result) => ({
        ...result,
        item: toPublicMemoryItem(result.item),
      })),
    });
    return true;
  }

  // Review-queue routes MUST match before the generic /v1/memory/{memoryId}
  // matcher below so a review id is never mistaken for a memory item id.
  if (pathname === '/v1/memory/reviews' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:read']);
    if (!auth) return true;
    const subject = readReviewSubject(res, url, auth);
    if (!subject) return true;
    const limit = parseReviewPagingNumber(url.searchParams.get('limit'));
    const offset = parseReviewPagingNumber(url.searchParams.get('offset'));
    const response = await processPendingMemoryReviewRequest({
      request: {
        requestId: `memory-review-page-${randomUUID()}`,
        action: 'memory_review_pending',
        payload: {
          ...(limit === undefined ? {} : { limit }),
          ...(offset === undefined ? {} : { offset }),
        },
      },
      subject,
    });
    sendJson(res, 200, response.data);
    return true;
  }

  const decisionReviewId = parseReviewDecisionPath(pathname);
  if (decisionReviewId && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:admin']);
    if (!auth) return true;
    if (!service.isEnabled()) {
      sendMemoryDisabled(res);
      return true;
    }
    const subject = readReviewSubject(res, url, auth);
    if (!subject) return true;
    const parsed = await readJson(req);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      sendError(res, 400, 'INVALID_REQUEST', 'request body must be an object');
      return true;
    }
    const body = parsed as Record<string, unknown>;
    const decision = body.decision;
    if (
      decision !== 'approve' &&
      decision !== 'reject' &&
      decision !== 'edit_approve'
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'decision must be approve, reject, or edit_approve',
      );
      return true;
    }
    // edit_approve replaces the recorded value, so it is meaningless without a
    // non-empty editedValue — reject here rather than forward a broken decision.
    if (
      decision === 'edit_approve' &&
      (typeof body.editedValue !== 'string' || !body.editedValue.trim())
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'editedValue is required for an edit_approve decision',
      );
      return true;
    }
    // Boundary + freshness gate. getReviewDetail is scoped to this exact
    // app/subject, so a review outside the key's scope reads as unknown (404).
    const existing = await service.getReviewDetail({
      ...subject,
      reviewId: decisionReviewId,
    });
    if (!existing) {
      sendError(res, 404, 'NOT_FOUND', 'Review not found');
      return true;
    }
    if (existing.status !== 'pending_review') {
      sendError(
        res,
        409,
        'REVIEW_NOT_PENDING',
        'This review is no longer pending',
      );
      return true;
    }
    // Reviewer identity comes from the AUTHENTICATED KEY, never the request
    // body; decision_source records the control API as the decision origin.
    const reviewerId = `control_api:${auth.kid}`;
    try {
      const response = await processMemoryReviewDecisionRequest({
        request: {
          requestId: `memory-review-decision-${randomUUID()}`,
          action: 'memory_review_decision',
          payload: {
            review_id: decisionReviewId,
            decision,
            ...(typeof body.editedValue === 'string'
              ? { edited_value: body.editedValue }
              : {}),
            ...(typeof body.reason === 'string'
              ? { edited_reason: body.reason }
              : {}),
            decision_source: 'control_api',
          },
          context: { userId: reviewerId, reviewerIsControlApprover: true },
        },
        subject,
      });
      const review = (response.data as { review?: unknown } | undefined)
        ?.review;
      sendJson(res, 200, { review });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      // Lost the conditional pending_review claim between the lookup and the
      // decision (a concurrent decision won) — the review is no longer pending.
      if (/pending memory review not found/i.test(message)) {
        sendError(
          res,
          409,
          'REVIEW_NOT_PENDING',
          'This review is no longer pending',
        );
        return true;
      }
      throw error;
    }
  }

  const detailReviewId = parseReviewDetailPath(pathname);
  if (detailReviewId && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:read']);
    if (!auth) return true;
    const subject = readReviewSubject(res, url, auth);
    if (!subject) return true;
    const review = await service.getReviewDetail({
      ...subject,
      reviewId: detailReviewId,
    });
    if (!review) {
      sendError(res, 404, 'NOT_FOUND', 'Review not found');
      return true;
    }
    sendJson(res, 200, { review });
    return true;
  }

  const memoryId = parseMemoryId(pathname);
  if (memoryId && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:admin']);
    if (!auth) return true;
    if (!service.isEnabled()) {
      sendMemoryDisabled(res);
      return true;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    const appId = readAppId(body, auth.appId);
    if (!assertAppAccess(res, appId, auth)) return true;
    const memory = await service.patch({
      ...(body as unknown as PatchAppMemoryInput),
      id: memoryId,
      appId,
      isAdminWrite: auth.scopes.has('memory:admin'),
    });
    sendJson(res, 200, { memory: toPublicMemoryItem(memory) });
    return true;
  }

  if (memoryId && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:admin']);
    if (!auth) return true;
    if (!service.isEnabled()) {
      sendMemoryDisabled(res);
      return true;
    }
    const appId = url.searchParams.get('appId') || auth.appId;
    if (!assertAppAccess(res, appId, auth)) return true;
    const result = await service.delete({
      id: memoryId,
      appId,
      agentId: url.searchParams.get('agentId') || undefined,
      personId: url.searchParams.get('personId') || undefined,
      groupId: url.searchParams.get('groupId') || undefined,
      channelId: url.searchParams.get('channelId') || undefined,
      threadId: url.searchParams.get('threadId') || undefined,
      isAdminWrite: auth.scopes.has('memory:admin'),
    } satisfies DeleteAppMemoryInput);
    sendJson(res, 200, result);
    return true;
  }

  if (pathname === '/v1/memory/dreaming/trigger' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:admin']);
    if (!auth) return true;
    if (!service.isEnabled()) {
      sendMemoryDisabled(res);
      return true;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    const appId = readAppId(body, auth.appId);
    if (!assertAppAccess(res, appId, auth)) return true;
    const run = await service.triggerDreaming({
      ...(body as unknown as DreamingTriggerInput),
      appId,
    });
    sendJson(res, 202, { run });
    return true;
  }

  if (pathname === '/v1/memory/dreaming/status' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:read']);
    if (!auth) return true;
    const appId = url.searchParams.get('appId') || auth.appId;
    if (!assertAppAccess(res, appId, auth)) return true;
    // Control API is the explicit admin-readable app/agent-wide dreaming status
    // surface. Channel runtime status callers pass resolved subject scope.
    const runs = await service.dreamingStatus({
      appId,
      agentId: url.searchParams.get('agentId') || undefined,
    });
    sendJson(res, 200, { runs });
    return true;
  }

  return false;
}
