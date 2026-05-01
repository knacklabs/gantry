import type { IncomingMessage, ServerResponse } from 'node:http';

import { listModelCatalogEntries } from '../../../shared/model-catalog.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { sendError, sendJson } from '../http.js';

function modelToResponse(
  entry: ReturnType<typeof listModelCatalogEntries>[number],
) {
  return {
    id: entry.id,
    modelProfileId: entry.id,
    displayName: entry.displayName,
    aliases: entry.aliases,
    recommendedAlias: entry.recommendedAlias,
    provider: entry.providerLabel,
    contextWindowTokens: entry.contextWindowTokens,
    maxOutputTokens: entry.maxOutputTokens,
    cacheMode: entry.cacheMode,
    cacheTokenFields: entry.cacheTokenFields,
    supportsThinking: entry.supportsThinking,
    supportsTools: entry.supportsTools,
    experimental: entry.experimental === true,
  };
}

export async function handleModelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/v1/models') return false;

  if (req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['sessions:read'])) {
      return true;
    }
    sendJson(res, 200, {
      models: listModelCatalogEntries().map(modelToResponse),
    });
    return true;
  }

  res.setHeader('Allow', 'GET');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}
