import type { IncomingMessage, ServerResponse } from 'node:http';

import { AppMemoryService } from '../../../memory/app-memory-service.js';
import type {
  AppMemorySearchInput,
  DeleteAppMemoryInput,
  DreamingTriggerInput,
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
    userId: url.searchParams.get('userId') || undefined,
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

export async function handleMemoryRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
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
    sendJson(res, 201, { memory: saved });
    return true;
  }

  if (pathname === '/v1/memory' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:read']);
    if (!auth) return true;
    const appId = url.searchParams.get('appId') || auth.appId;
    if (!assertAppAccess(res, appId, auth)) return true;
    const memories = await service.list(searchInputFromQuery(url, appId));
    sendJson(res, 200, { memories });
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
    sendJson(res, 200, { results });
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
    sendJson(res, 200, { memory });
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
      userId: url.searchParams.get('userId') || undefined,
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
