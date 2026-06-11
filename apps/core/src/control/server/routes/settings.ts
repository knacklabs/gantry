import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { parseRuntimeSettings } from '../../../config/settings/runtime-settings-parser.js';
import {
  importFleetSettingsRevision,
  settingsFromRevisionDocument,
} from '../../../config/settings/settings-import-service.js';
import type { AppId } from '../../../domain/app/app.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/settings/desired-state') {
    return handleDesiredState(req, res, ctx);
  }
  if (pathname === '/v1/settings/revisions') {
    return handleRevisionsList(req, res, ctx);
  }
  if (pathname !== '/v1/settings') return false;

  if (req.method === 'GET') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['agents:admin'])) {
      return true;
    }
    sendJson(res, 200, { settings: ctx.getRuntimeSettings() });
    return true;
  }

  if (req.method === 'PATCH') {
    if (!authorizeControlRequest(req, res, ctx.keys, ['agents:admin'])) {
      return true;
    }
    res.setHeader('connection', 'close');
    sendError(
      res,
      409,
      'SETTINGS_READ_ONLY',
      'The typed settings API is read-only. Use CLI settings commands or the reviewed settings_desired_state/request_settings_update admin tools to change settings.',
    );
    return true;
  }

  res.setHeader('Allow', 'GET, PATCH');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}

/**
 * Fleet desired-state surface (ADR-3). The future management UI builds on these
 * endpoints. Mutations append a `settings_revisions` row through the same
 * validation path the YAML import uses; workers converge via NOTIFY + poll.
 */
async function handleDesiredState(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
): Promise<boolean> {
  if (req.method === 'GET') {
    const key = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!key) return true;
    const appId = key.appId as AppId;
    const latest =
      await getRuntimeStorage().repositories.settingsRevisions.getLatestSettingsRevision(
        appId,
      );
    if (!latest) {
      sendJson(res, 200, { revision: 0, settingsYaml: null, updatedAt: null });
      return true;
    }
    let settingsYaml: string | null = null;
    try {
      settingsYaml =
        typeof latest.settingsDocument.yaml === 'string'
          ? latest.settingsDocument.yaml
          : null;
    } catch {
      settingsYaml = null;
    }
    sendJson(res, 200, {
      revision: latest.revision,
      minReaderVersion: latest.minReaderVersion,
      settingsYaml,
      createdBy: latest.createdBy,
      note: latest.note,
      updatedAt: latest.createdAt,
    });
    return true;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const key = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!key) return true;
    const appId = key.appId as AppId;
    const body = (await readJson(req)) as {
      settingsYaml?: unknown;
      expectedRevision?: unknown;
      note?: unknown;
    };
    if (typeof body.settingsYaml !== 'string' || !body.settingsYaml.trim()) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'settingsYaml is required and must be a non-empty YAML document string.',
      );
      return true;
    }
    if (
      body.expectedRevision !== undefined &&
      body.expectedRevision !== null &&
      !Number.isInteger(body.expectedRevision)
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'expectedRevision must be an integer when provided.',
      );
      return true;
    }
    let parsed;
    try {
      parsed = parseRuntimeSettings(body.settingsYaml);
    } catch (err) {
      sendError(
        res,
        400,
        'INVALID_SETTINGS',
        err instanceof Error ? err.message : 'settingsYaml failed to parse.',
      );
      return true;
    }
    const storage = getRuntimeStorage();
    const outcome = await importFleetSettingsRevision(
      {
        runtimeHome: ctx.runtimeHome,
        ops: getRuntimeStorage().ops,
        repositories: storage.repositories,
        appId,
        settingsRevisions: storage.repositories.settingsRevisions,
        pool: storage.service.pool,
        createdBy: `control-api:${key.kid}`,
      },
      parsed,
      {
        expectedRevision:
          typeof body.expectedRevision === 'number'
            ? body.expectedRevision
            : null,
        note: typeof body.note === 'string' ? body.note : null,
      },
    );
    if (outcome.status === 'invalid') {
      sendError(
        res,
        400,
        'INVALID_SETTINGS',
        'Settings document failed validation.',
        { errors: outcome.errors },
      );
      return true;
    }
    if (outcome.status === 'conflict') {
      sendError(
        res,
        409,
        'REVISION_CONFLICT',
        `expectedRevision ${outcome.expectedRevision} does not match the current revision ${outcome.actualRevision}.`,
        {
          expectedRevision: outcome.expectedRevision,
          actualRevision: outcome.actualRevision,
        },
      );
      return true;
    }
    sendJson(res, 200, { revision: outcome.revision });
    return true;
  }

  res.setHeader('Allow', 'GET, PUT, POST');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}

async function handleRevisionsList(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
): Promise<boolean> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    return true;
  }
  const key = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
  if (!key) return true;
  const appId = key.appId as AppId;
  const revisions =
    await getRuntimeStorage().repositories.settingsRevisions.listRecentSettingsRevisions(
      { appId, limit: 50 },
    );
  sendJson(res, 200, {
    revisions: revisions.map((revision) => ({
      revision: revision.revision,
      minReaderVersion: revision.minReaderVersion,
      createdBy: revision.createdBy,
      note: revision.note,
      createdAt: revision.createdAt,
    })),
  });
  return true;
}

// Re-exported so route tests can assert the document round-trip path used by
// the worker listener matches the API write path.
export { settingsFromRevisionDocument };
