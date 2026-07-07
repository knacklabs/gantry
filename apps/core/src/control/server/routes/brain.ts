import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  countRuntimeBrainHarvestEnabledConversations,
  createRuntimeBrainService,
} from '../../../brain/brain-runtime.js';
import type { BrainPageSourceKind } from '../../../brain/brain-types.js';
import { canAccessApp } from '../app-identity.js';
import { isValidControlId, type ApiKeyRecord } from '../auth.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

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

function parseImportPages(body: Record<string, unknown>) {
  const rawPages = Array.isArray(body.pages) ? body.pages : [];
  return rawPages.map((entry) => {
    const page =
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>)
        : {};
    const slug = typeof page.slug === 'string' ? page.slug.trim() : '';
    const markdown =
      typeof page.markdown === 'string' ? page.markdown : undefined;
    if (!slug || markdown === undefined) {
      throw Object.assign(
        new Error('pages[].slug and pages[].markdown are required'),
        { statusCode: 400, code: 'INVALID_REQUEST' },
      );
    }
    return {
      slug,
      markdown,
      title: typeof page.title === 'string' ? page.title : undefined,
      sourceKind: 'import' as BrainPageSourceKind,
      sourceRef: typeof page.sourceRef === 'string' ? page.sourceRef : null,
      authorId: typeof page.authorId === 'string' ? page.authorId : null,
    };
  });
}

export async function handleBrainRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/v1/brain')) return false;

  if (pathname === '/v1/brain/status' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:read']);
    if (!auth) return true;
    const appId = url.searchParams.get('appId') || auth.appId;
    if (!assertAppAccess(res, appId, auth)) return true;
    const brain = createRuntimeBrainService(appId);
    sendJson(res, 200, {
      status: {
        ...(await brain.status(appId)),
        harvestEnabledConversations:
          countRuntimeBrainHarvestEnabledConversations(),
      },
    });
    return true;
  }

  if (pathname === '/v1/brain/import' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['memory:admin']);
    if (!auth) return true;
    const body = (await readJson(req, 5 * 1024 * 1024)) as Record<
      string,
      unknown
    >;
    const appId = readAppId(body, auth.appId);
    if (!assertAppAccess(res, appId, auth)) return true;
    const pages = parseImportPages(body);
    const brain = createRuntimeBrainService(appId);
    let created = 0;
    let updated = 0;
    for (const page of pages) {
      const result = await brain.write({ appId, ...page });
      if (result.created) created += 1;
      else updated += 1;
    }
    sendJson(res, 201, { imported: pages.length, created, updated });
    return true;
  }

  return false;
}
