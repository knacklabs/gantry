import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { parseRuntimeSettingsObject } from '../../../config/settings/runtime-settings-parser.js';
import type { RuntimeSettings } from '../../../config/settings/runtime-settings-types.js';
import {
  importFleetSettingsRevision,
  importWorkstationSettings,
  SettingsRevisionConflictError,
  SettingsStaleMutationError,
  settingsFromRevisionDocument,
  settingsToRevisionDocument,
} from '../../../config/settings/settings-import-service.js';
import type { AppId } from '../../../domain/app/app.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import type { RuntimeDeploymentMode } from '../../../shared/runtime-deployment-mode.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

// observability.tracing is private in v1: the exporter endpoint pairs with
// the GANTRY_OTEL_TRACES_HEADERS secret, so exposing it read/write here
// would let an agents:admin caller redirect authenticated telemetry to a
// server it controls. The block persists in durable revisions but is
// stripped from reads and preserved server-side across writes; changing it
// requires the filesystem surfaces (settings.yaml / CLI --file).
function omitObservability<T extends Record<string, unknown>>(
  document: T,
): Record<string, unknown> {
  const { observability: _observability, ...rest } = document;
  return rest;
}

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
    sendJson(res, 200, {
      settings: omitObservability(
        ctx.getRuntimeSettings() as unknown as Record<string, unknown>,
      ),
    });
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
 * Desired-state revision surface. The API/SDK/future UI speak the typed
 * JSON settings document (the same shape stored as `settings_revisions` jsonb);
 * YAML is the human file format for the workstation file + CLI `--file` edge
 * only and never appears here. Mutations decode the inbound document through the
 * shared settings parser and append a `settings_revisions` row through the same
 * validation path the file import uses; runtimes converge via NOTIFY + poll.
 */
async function handleDesiredState(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  write?: {
    key: { appId: string; kid: string };
    body: unknown;
  },
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
      settings: omitObservability(
        latest.settingsDocument as Record<string, unknown>,
      ),
      createdBy: latest.createdBy,
      note: latest.note,
      updatedAt: latest.createdAt,
    });
    return true;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const key =
      write?.key ??
      authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!key) return true;
    const appId = key.appId as AppId;
    const body = (write ? write.body : await readJson(req)) as {
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
    const callerGuard =
      typeof body.expectedRevision === 'number' ? body.expectedRevision : null;
    const note = typeof body.note === 'string' ? body.note : null;
    const storage = getRuntimeStorage();
    const isWorkstation = currentDeploymentMode(ctx) === 'workstation';
    // Preserve the server-side observability block across writes: this
    // surface can neither read nor set it (see omitObservability above).
    // Preservation requires a read-merge-append bound to the head we merged
    // from (an unconditional append could silently revert a concurrent
    // observability change, including the FIRST enable). Callers who supplied
    // expectedRevision keep the documented 409; callers who omitted it keep
    // their unconditional semantics via a bounded server-side retry.
    for (let attempt = 0; ; attempt += 1) {
      const head =
        await storage.repositories.settingsRevisions.getLatestSettingsRevision(
          appId,
        );
      const preservedObservability =
        (head?.settingsDocument as Record<string, unknown> | undefined)
          ?.observability ??
        (head
          ? undefined
          : settingsToRevisionDocument(
              ctx.getInternalRuntimeSettings() as RuntimeSettings,
            ).observability);
      const inboundDocument = {
        ...omitObservability(body.settings as Record<string, unknown>),
        ...(preservedObservability !== undefined
          ? { observability: preservedObservability }
          : {}),
      };
      // 0 = "expect no head". Every attempt is fenced to the head it merged
      // from — dropping the fence on any attempt could silently revert a
      // concurrent change to the private observability block, which API
      // callers cannot even see. Unguarded writers get generous fresh-head
      // retries; contention that survives them earns an honest 409.
      const lastAttempt = attempt >= 4;
      const effectiveExpectedRevision = callerGuard ?? head?.revision ?? 0;
      // Decode the inbound typed document through the shared settings parser
      // so a structurally invalid document surfaces the same
      // document-path-level error the file/CLI surface produces (one
      // validation path). YAML never reaches this surface — it is the CLI
      // `--file` edge only.
      let parsed;
      try {
        parsed = parseRuntimeSettingsObject(inboundDocument);
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
      if (isWorkstation) {
        let revision = 0;
        try {
          const outcome = await importWorkstationSettings(
            {
              runtimeHome: ctx.runtimeHome,
              ops: storage.ops,
              repositories: storage.repositories,
              appId,
              previousSettings: ctx.getInternalRuntimeSettings() as never,
              reloadRuntimeState: () => ctx.app.loadState(),
              revisionMirror: {
                settingsRevisions: storage.repositories.settingsRevisions,
                pool: storage.service.pool,
                createdBy: `control-api:${key.kid}`,
                note,
                logWarn: (context, message) => logger.warn(context, message),
              },
              revisionMirrorRequired: true,
              expectedRevision: effectiveExpectedRevision,
            },
            parsed,
          );
          revision =
            outcome.revision ??
            (
              await storage.repositories.settingsRevisions.getLatestSettingsRevision(
                appId,
              )
            )?.revision ??
            0;
        } catch (err) {
          // A concurrent winner can make the in-memory previousSettings stale
          // before reload completes — retryable for unguarded writers, same
          // as a CAS conflict.
          if (
            err instanceof SettingsStaleMutationError &&
            callerGuard === null &&
            !lastAttempt
          ) {
            continue;
          }
          if (err instanceof SettingsRevisionConflictError) {
            if (callerGuard === null && !lastAttempt) continue;
            sendError(
              res,
              409,
              'REVISION_CONFLICT',
              `expectedRevision ${err.expectedRevision} does not match the current revision ${err.actualRevision}.`,
              {
                expectedRevision: err.expectedRevision,
                actualRevision: err.actualRevision,
              },
            );
            return true;
          }
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
        sendJson(res, 200, { revision });
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
          expectedRevision: effectiveExpectedRevision,
          note,
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
        if (callerGuard === null && !lastAttempt) continue;
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
  }

  res.setHeader('Allow', 'GET, PUT, POST');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}

export function writeControlDesiredState(input: {
  res: ServerResponse;
  ctx: ControlRouteContext;
  key: { appId: string; kid: string };
  body: unknown;
}): Promise<boolean> {
  return handleDesiredState(
    { method: 'PUT' } as IncomingMessage,
    input.res,
    input.ctx,
    { key: input.key, body: input.body },
  );
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
