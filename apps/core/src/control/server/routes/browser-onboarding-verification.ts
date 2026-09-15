import type { IncomingMessage, ServerResponse } from 'node:http';

import { and, eq } from 'drizzle-orm';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { onboardingVerificationsPostgres } from '../../../adapters/storage/postgres/schema/schema.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import type { AppId } from '../../../domain/app/app.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import { sendError, sendJson } from '../http.js';
import { activeSession } from './browser-auth.js';
import {
  requireOnboardingAdministrator,
  type BrowserOnboardingSettings,
} from './browser-onboarding-auth.js';

export async function projectOnboardingVerification(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  settings: BrowserOnboardingSettings,
  id: string,
): Promise<boolean> {
  const session = await requireOnboardingAdministrator(req, res, settings);
  if (!session) return true;
  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  const [verification] = await storage.service.db
    .select()
    .from(onboardingVerificationsPostgres)
    .where(
      and(
        eq(onboardingVerificationsPostgres.id, id),
        eq(onboardingVerificationsPostgres.appId, appId),
      ),
    )
    .limit(1);
  if (!verification) {
    sendError(res, 404, 'NOT_FOUND', 'Verification not found.');
    return true;
  }
  if (!['satisfied', 'projection_failed'].includes(verification.status)) {
    sendError(
      res,
      409,
      'ONBOARDING_VERIFICATION_NOT_SATISFIED',
      'A correlated inbound message and reply are required before projection.',
    );
    return true;
  }
  const now = new Date().toISOString();
  try {
    await ctx.syncSettingsFromProjection(appId);
    await storage.service.db
      .update(onboardingVerificationsPostgres)
      .set({
        status: 'completed',
        projectionFailureCode: null,
        completedAt: now,
        updatedAt: now,
        updatedBy: session.userId,
      })
      .where(
        and(
          eq(onboardingVerificationsPostgres.id, id),
          eq(onboardingVerificationsPostgres.appId, appId),
        ),
      );
    sendJson(res, 200, { verification: { id, status: 'completed' } });
  } catch {
    await storage.service.db
      .update(onboardingVerificationsPostgres)
      .set({
        status: 'projection_failed',
        projectionFailureCode: 'RUNTIME_PROJECTION_FAILED',
        updatedAt: now,
        updatedBy: session.userId,
      })
      .where(
        and(
          eq(onboardingVerificationsPostgres.id, id),
          eq(onboardingVerificationsPostgres.appId, appId),
        ),
      );
    sendError(
      res,
      503,
      'RUNTIME_PROJECTION_FAILED',
      'The verified setup could not be projected. Retry projection.',
    );
  }
  return true;
}

export async function getOnboardingVerification(
  req: IncomingMessage,
  res: ServerResponse,
  settings: BrowserOnboardingSettings,
  id: string,
): Promise<boolean> {
  const session = await activeSession(req, settings.authentication.mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return true;
  }
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return true;
  }
  const storage = getRuntimeStorage();
  const appId = session.appId as AppId;
  const [verification] = await storage.service.db
    .select()
    .from(onboardingVerificationsPostgres)
    .where(
      and(
        eq(onboardingVerificationsPostgres.id, id),
        eq(onboardingVerificationsPostgres.appId, appId),
      ),
    )
    .limit(1);
  if (!verification) {
    sendError(res, 404, 'NOT_FOUND', 'Verification not found.');
    return true;
  }
  const status =
    ['pending', 'inbound_received'].includes(verification.status) &&
    verification.expiresAt < new Date().toISOString()
      ? 'expired'
      : verification.status;
  sendJson(res, 200, {
    verification: {
      id: verification.id,
      status,
      expiresAt: verification.expiresAt,
      satisfiedAt: verification.satisfiedAt,
      completedAt: verification.completedAt,
      failureCode:
        status === 'expired'
          ? 'VERIFICATION_EXPIRED'
          : ['pending', 'inbound_received'].includes(status)
            ? 'VERIFICATION_PENDING'
            : verification.projectionFailureCode,
    },
  });
  return true;
}
