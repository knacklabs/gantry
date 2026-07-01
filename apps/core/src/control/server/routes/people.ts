import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  AddPersonAliasRequestSchema,
  IdentityResolveRequestSchema,
  PersonMergeRequestSchema,
} from '@gantry/contracts';

import { PostgresPersonIdentityRepository } from '../../../adapters/storage/postgres/repositories/person-identity-repository.postgres.js';
import {
  getRuntimeEventExchange,
  getRuntimeStorage,
} from '../../../adapters/storage/postgres/runtime-store.js';
import {
  publishIdentityAliasLinkedEvent,
  publishIdentityAliasRetiredEvent,
  publishIdentityResolvedEvent,
} from '../../../application/identity/identity-runtime-events.js';
import { PersonIdentityService } from '../../../application/identity/person-identity-service.js';
import { canAccessApp } from '../app-identity.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import {
  readJson,
  sendApplicationError,
  sendError,
  sendJson,
} from '../http.js';
import { isValidControlId, type ApiKeyRecord } from '../auth.js';

function service(): PersonIdentityService {
  return new PersonIdentityService(
    new PostgresPersonIdentityRepository(getRuntimeStorage().service.db),
  );
}

function readAppId(input: Record<string, unknown>, fallback: string): string {
  return typeof input.appId === 'string' && input.appId.trim()
    ? input.appId.trim()
    : fallback;
}

function assertPeopleAppAccess(
  res: ServerResponse,
  appId: string,
  auth: ApiKeyRecord,
): boolean {
  if (!isValidControlId(appId)) {
    sendError(res, 400, 'INVALID_REQUEST', 'appId is invalid');
    return false;
  }
  if (!canAccessApp(auth, appId)) {
    sendError(res, 403, 'FORBIDDEN', 'Person is not accessible to this app.');
    return false;
  }
  return true;
}

function personIdFromPath(pathname: string): string | null {
  const match = /^\/v1\/people\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function aliasPath(pathname: string): {
  personId: string;
  aliasId?: string;
} | null {
  const match = /^\/v1\/people\/([^/]+)\/aliases(?:\/([^/]+))?$/.exec(pathname);
  if (!match) return null;
  return {
    personId: decodeURIComponent(match[1]!),
    aliasId: match[2] ? decodeURIComponent(match[2]) : undefined,
  };
}

function mergePath(pathname: string): {
  personId: string;
  preview: boolean;
} | null {
  const match = /^\/v1\/people\/([^/]+)\/merge(?::preview)?$/.exec(pathname);
  if (!match) return null;
  return {
    personId: decodeURIComponent(match[1]!),
    preview: pathname.endsWith('merge:preview'),
  };
}

export async function handlePeopleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/identity/resolve' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'identity:resolve',
    ]);
    if (!auth) return true;
    const parsed = IdentityResolveRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid identity resolve request',
      );
      return true;
    }
    const appId = parsed.data.appId?.trim() || auth.appId;
    if (!assertPeopleAppAccess(res, appId, auth)) return true;
    try {
      const result = await service().resolve({ ...parsed.data, appId });
      await publishIdentityResolvedEvent(
        (event) => getRuntimeEventExchange().publish(event),
        {
          appId,
          source: 'control_api',
          provider: parsed.data.provider,
          providerConnectionId: parsed.data.providerConnectionId,
          evidenceType: parsed.data.evidenceType,
          status: result.status,
          personId: result.personId,
          verificationStatus: result.verificationStatus,
          memoryHydrationEligible: result.memoryHydrationEligible,
        },
      );
      sendJson(res, 200, result);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (pathname === '/v1/people' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['people:read']);
    if (!auth) return true;
    const appId = url.searchParams.get('appId') || auth.appId;
    if (!assertPeopleAppAccess(res, appId, auth)) return true;
    sendJson(res, 200, { people: await service().listPeople(appId) });
    return true;
  }

  const personId = personIdFromPath(pathname);
  if (personId && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['people:read']);
    if (!auth) return true;
    const appId = url.searchParams.get('appId') || auth.appId;
    if (!assertPeopleAppAccess(res, appId, auth)) return true;
    try {
      sendJson(res, 200, {
        person: await service().getPerson(appId, personId),
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const alias = aliasPath(pathname);
  if (alias && !alias.aliasId && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['people:admin']);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const parsed = AddPersonAliasRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid person alias request');
      return true;
    }
    const appId = readAppId(body, auth.appId);
    if (!assertPeopleAppAccess(res, appId, auth)) return true;
    try {
      const created = await service().addAlias({
        ...parsed.data,
        appId,
        personId: alias.personId,
        actor: auth.kid,
      });
      await publishIdentityAliasLinkedEvent(
        (event) => getRuntimeEventExchange().publish(event),
        {
          appId,
          personId: created.personId,
          aliasId: created.id,
          provider: created.provider,
          providerConnectionId: created.providerConnectionId,
          verificationStatus: created.verificationStatus,
          actor: auth.kid,
        },
      );
      sendJson(res, 201, { alias: created });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (alias?.aliasId && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['people:admin']);
    if (!auth) return true;
    const appId = url.searchParams.get('appId') || auth.appId;
    if (!assertPeopleAppAccess(res, appId, auth)) return true;
    try {
      const retired = await service().retireAlias({
        appId,
        personId: alias.personId,
        aliasId: alias.aliasId,
        actor: auth.kid,
      });
      await publishIdentityAliasRetiredEvent(
        (event) => getRuntimeEventExchange().publish(event),
        {
          appId,
          personId: retired.personId,
          aliasId: retired.id,
          provider: retired.provider,
          providerConnectionId: retired.providerConnectionId,
          verificationStatus: retired.verificationStatus,
          actor: auth.kid,
        },
      );
      sendJson(res, 200, { alias: retired });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const merge = mergePath(pathname);
  if (merge && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['people:admin']);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const parsed = PersonMergeRequestSchema.safeParse(body);
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid person merge request');
      return true;
    }
    const appId = readAppId(body, auth.appId);
    if (!assertPeopleAppAccess(res, appId, auth)) return true;
    try {
      const input = {
        appId,
        targetPersonId: merge.personId,
        sourcePersonId: parsed.data.sourcePersonId,
        idempotencyKey: parsed.data.idempotencyKey,
        conflictResolution: parsed.data.conflictResolution,
        actor: auth.kid,
      };
      const result = merge.preview
        ? await service().previewMerge(input)
        : await service().mergePeople(input);
      sendJson(res, 200, result);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  return false;
}
