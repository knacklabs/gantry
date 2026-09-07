import type { IncomingMessage, ServerResponse } from 'node:http';

import { PostgresPersonIdentityRepository } from '../../../adapters/storage/postgres/repositories/person-identity-repository.postgres.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import { PersonIdentityService } from '../../../application/identity/person-identity-service.js';
import { normalizeProviderId } from '../../../channels/provider-registry.js';
import type { AppId } from '../../../domain/app/app.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import { sendError, sendJson } from '../http.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { activeSession } from './browser-auth.js';

const PEOPLE_PATH = '/ui/api/people';

type BrowserPeopleSettings = {
  authentication: { mode: 'local' | 'hosted' };
};

export function isBrowserPeoplePath(pathname: string): boolean {
  return pathname === PEOPLE_PATH;
}

export async function handleBrowserPeopleRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  settings: BrowserPeopleSettings,
): Promise<boolean> {
  if (!isBrowserPeoplePath(pathname)) return false;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    return true;
  }
  const session = await activeSession(req, settings.authentication.mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'people:read')) {
    sendError(res, 403, 'FORBIDDEN', 'Viewer access is required.');
    return true;
  }

  const storage = getRuntimeStorage();
  const people = await new PersonIdentityService(
    new PostgresPersonIdentityRepository(storage.service.db),
    (provider) =>
      normalizeProviderId(provider) || provider.trim().toLowerCase(),
  ).listPeople(session.appId as AppId, { limit: 200 });
  sendJson(res, 200, {
    people: people.people.map((person) => ({
      id: person.personId,
      kind: person.kind,
      displayName: person.displayName ?? 'Unnamed person',
      status: person.status,
      aliases: (person.aliases ?? []).map((alias) => ({
        id: alias.id,
        provider: alias.provider,
        displayName: alias.displayName ?? null,
        verificationStatus: alias.verificationStatus,
      })),
      aliasCounts: person.aliasCounts ?? {},
      updatedAt: person.updatedAt,
    })),
  });
  return true;
}
