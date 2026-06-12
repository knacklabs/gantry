import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { parseRuntimeSettingsObject } from '../../../config/settings/runtime-settings-parser.js';
import {
  importFleetSettingsRevision,
  importWorkstationSettings,
  settingsFromRevisionDocument,
} from '../../../config/settings/settings-import-service.js';
import type { AppId } from '../../../domain/app/app.js';
import type { RuntimeDeploymentMode } from '../../../shared/runtime-deployment-mode.js';
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
 * Fleet desired-state surface (ADR-3). The API/SDK/future UI speak the typed
 * JSON settings document (the same shape stored as `settings_revisions` jsonb);
 * YAML is the human file format for the workstation file + CLI `--file` edge
 * only and never appears here. Mutations decode the inbound document through the
 * shared settings parser and append a `settings_revisions` row through the same
 * validation path the file import uses; workers converge via NOTIFY + poll.
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
      sendJson(res, 200, { revision: 0, settings: null, updatedAt: null });
      return true;
    }
    sendJson(res, 200, {
      revision: latest.revision,
      minReaderVersion: latest.minReaderVersion,
      settings: latest.settingsDocument,
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
      settings?: unknown;
      expectedRevision?: unknown;
      note?: unknown;
    };
    if (
      typeof body.settings !== 'object' ||
      body.settings === null ||
      Array.isArray(body.settings)
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'settings is required and must be a settings document object.',
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
    // Decode the inbound typed document through the shared settings parser so a
    // structurally invalid document surfaces the same document-path-level error
    // the file/CLI surface produces (one validation path). YAML never reaches
    // this surface — it is the CLI `--file` edge only.
    let parsed;
    try {
      parsed = parseRuntimeSettingsObject(
        body.settings as Record<string, unknown>,
      );
    } catch (err) {
      sendError(
        res,
        400,
        'INVALID_SETTINGS',
        err instanceof Error
          ? err.message
          : 'settings document failed to parse.',
      );
      return true;
    }
    const storage = getRuntimeStorage();
    if (currentDeploymentMode(ctx) === 'workstation') {
      if (
        body.expectedRevision !== undefined &&
        body.expectedRevision !== null
      ) {
        sendError(
          res,
          400,
          'INVALID_REQUEST',
          'expectedRevision is only supported for fleet settings revisions.',
        );
        return true;
      }
      try {
        await importWorkstationSettings(
          {
            runtimeHome: ctx.runtimeHome,
            ops: storage.ops,
            repositories: storage.repositories,
            appId,
            previousSettings: ctx.getInternalRuntimeSettings() as never,
            reloadRuntimeState: () => ctx.app.loadState(),
          },
          parsed,
        );
      } catch (err) {
        sendError(
          res,
          400,
          'INVALID_SETTINGS',
          err instanceof Error
            ? err.message
            : 'Settings document failed validation.',
        );
        return true;
      }
      sendJson(res, 200, { revision: 0 });
      return true;
    }
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

function currentDeploymentMode(
  ctx: ControlRouteContext,
): RuntimeDeploymentMode {
  return ctx.getRuntimeSettings().runtime.deploymentMode === 'workstation'
    ? 'workstation'
    : 'fleet';
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
