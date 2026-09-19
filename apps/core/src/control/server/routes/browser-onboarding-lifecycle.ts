import type { IncomingMessage, ServerResponse } from 'node:http';

import { PostgresAuthenticationRepository } from '../../../adapters/storage/postgres/repositories/authentication-repository.postgres.js';
import { PostgresOnboardingLifecycleRepository } from '../../../adapters/storage/postgres/repositories/onboarding-lifecycle-repository.postgres.js';
import { createRepositoryRuntimeSecretProvider } from '../../../adapters/credentials/repository-runtime-secret-provider.js';
import {
  getRuntimeStorage,
  tryAcquireRuntimeAdvisoryLease,
} from '../../../adapters/storage/postgres/runtime-store.js';
import { CapabilitySecretService } from '../../../application/capability-secrets/capability-secret-service.js';
import { ProviderAccountControlService } from '../../../application/provider-conversations/provider-conversation-control-use-cases.js';
import { DiscoverProviderConversationsService } from '../../../application/provider-conversations/provider-conversation-control-use-cases.js';
import {
  isModelCredentialRejectedError,
  verifyOnboardingModelCredential,
} from '../../../application/onboarding/model-credential-verification.js';
import { validateSlackWorkspaceCandidate } from '../../../application/onboarding/slack-workspace-validation.js';
import { ONBOARDING_VERIFICATION_TTL_MS } from '../../../application/onboarding/onboarding-state-machine.js';
import { channelSetupManifestFor } from '../../../channels/control-provider-catalog.js';
import { BuiltInControlChannelProviderCatalog } from '../../../channels/control-provider-catalog.js';
import { RuntimeSecretConversationDiscovery } from '../../../channels/control-provider-catalog.js';
import type { ConsoleRole } from '../../../application/auth/auth-foundations.js';
import type { AppId } from '../../../domain/app/app.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { ProviderId } from '../../../domain/provider/provider.js';
import type { ProviderAccountId } from '../../../domain/provider/provider.js';
import type { ConversationId } from '../../../domain/conversation/conversation.js';
import { gantryRuntimeSecretRef } from '../../../domain/ports/runtime-secret-provider.js';
import { runtimeSecretNameForProviderAccount } from '../../../domain/provider/provider-runtime-secret-keys.js';
import { randomUUID } from 'node:crypto';
import type { ModelCredential } from '../../../domain/model-credentials/model-credentials.js';
import { resolveModelSelectionForWorkload } from '../../../shared/model-catalog.js';
import { stableSha256Json } from '../../../shared/stable-hash.js';
import { nowIso } from '../../../shared/time/datetime.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import {
  readJson,
  sendApplicationError,
  sendError,
  sendJson,
} from '../http.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';
import {
  createBrowserConversationAdministrationService,
  sendBrowserJoinConversation,
  sendBrowserConversationMembers,
} from './browser-conversation-members.js';

const ROOT = '/ui/api/onboarding';

type BrowserOnboardingSettings = {
  authentication: { mode: 'local' | 'hosted'; canonicalOrigin: string };
};

export function isBrowserOnboardingPath(pathname: string): boolean {
  return pathname.startsWith(`${ROOT}/`);
}

export async function handleBrowserOnboardingRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserOnboardingSettings,
  url?: URL,
): Promise<boolean> {
  if (!isBrowserOnboardingPath(pathname)) return false;
  const mode = settings.authentication.mode;
  const storage = getRuntimeStorage();
  const onboarding = new PostgresOnboardingLifecycleRepository(
    storage.service.db,
  );
  const authentication = new PostgresAuthenticationRepository(
    storage.service.db,
  );

  if (pathname === `${ROOT}/channel-manifest`) {
    if (req.method !== 'GET') return wrongMethod(res, 'GET');
    const session = await requireAdministratorRead(req, res, mode);
    if (!session) return true;
    const manifest = channelSetupManifestFor(
      url?.searchParams.get('providerId') ?? '',
      url?.searchParams.get('employeeName') ?? '',
    );
    if (!manifest) {
      sendError(res, 404, 'NOT_FOUND', 'No setup manifest is available.');
      return true;
    }
    sendJson(res, 200, manifest);
    return true;
  }

  if (pathname === `${ROOT}/status`) {
    if (req.method !== 'GET') return wrongMethod(res, 'GET');
    const session = await activeSession(req, mode);
    if (!session) {
      sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
      return true;
    }
    const completedAt = await authentication.onboardingCompletedAt(session);
    sendJson(
      res,
      200,
      await onboarding.status({
        appId: session.appId,
        userId: session.userId,
        completedAt,
      }),
    );
    return true;
  }

  if (pathname === `${ROOT}/conversations`) {
    if (req.method !== 'GET') return wrongMethod(res, 'GET');
    const session = await requireAdministratorRead(req, res, mode);
    if (!session) return true;
    const status = await onboarding.status({
      appId: session.appId,
      userId: session.userId,
      completedAt: null,
    });
    const providerAccountId = status.deployment?.providerAccountId;
    if (!providerAccountId) {
      sendError(res, 409, 'SLACK_NOT_CONNECTED', 'Connect Slack first.');
      return true;
    }
    const discovery = new DiscoverProviderConversationsService({
      providerAccounts: storage.repositories.providerAccounts,
      conversations: storage.repositories.conversations,
      discovery: new RuntimeSecretConversationDiscovery(
        createRepositoryRuntimeSecretProvider({
          appId: session.appId as AppId,
          repository: storage.repositories.capabilitySecrets,
        }),
      ),
      ids: { generate: randomUUID },
      clock: { now: nowIso },
    });
    try {
      const conversations = await discovery.execute({
        appId: session.appId as AppId,
        providerAccountId: providerAccountId as ProviderAccountId,
      });
      sendJson(res, 200, {
        conversations: conversations.map((conversation) => ({
          id: conversation.id,
          title: conversation.title ?? null,
          kind: conversation.kind,
          status: conversation.status,
          membership: conversation.membership ?? 'joined',
        })),
        nextCursor: null,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const membersMatch = pathname.match(
    /^\/ui\/api\/onboarding\/conversations\/([^/]+)\/members$/,
  );
  if (membersMatch && req.method === 'GET') {
    const session = await requireAdministratorRead(req, res, mode);
    if (!session) return true;
    await sendBrowserConversationMembers(
      res,
      session.appId as AppId,
      decodeURIComponent(membersMatch[1]!) as ConversationId,
    );
    return true;
  }

  if (pathname === `${ROOT}/challenge` && req.method === 'GET') {
    const session = await requireAdministratorRead(req, res, mode);
    if (!session) return true;
    const challenge = await onboarding.currentChallenge({
      appId: session.appId,
      userId: session.userId,
    });
    sendJson(res, 200, {
      challenge: challenge
        ? {
            id: challenge.id,
            state: challenge.state,
            message: challenge.challengeText,
            expiresAt: challenge.expiresAt,
            deploymentVersion: challenge.deploymentVersion,
          }
        : null,
    });
    return true;
  }

  const session = await requireBrowserMutationSession({
    req,
    res,
    mode,
    originIsValid: isCanonicalBrowserOrigin(
      req,
      settings.authentication.canonicalOrigin,
    ),
  });
  if (!session) return true;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return true;
  }

  const joinConversationMatch = pathname.match(
    /^\/ui\/api\/onboarding\/conversations\/([^/]+)\/join$/,
  );
  if (joinConversationMatch) {
    if (req.method !== 'POST') return wrongMethod(res, 'POST');
    await sendBrowserJoinConversation(
      res,
      session.appId as AppId,
      decodeURIComponent(joinConversationMatch[1]!) as ConversationId,
    );
    return true;
  }

  if (pathname === `${ROOT}/complete`) {
    if (req.method !== 'POST') return wrongMethod(res, 'POST');
    const body = await readObject(req, res);
    if (!body) return true;
    await withIdempotency({
      req,
      res,
      session,
      repository: onboarding,
      operation: 'onboarding.complete',
      body,
      run: async () => {
        const status = await onboarding.status({
          appId: session.appId,
          userId: session.userId,
          completedAt: null,
        });
        if (
          !status.deployment ||
          status.deployment.state !== 'ready' ||
          !status.deployment.readyAt ||
          body.expectedVersion !== status.deployment.version
        ) {
          return {
            statusCode: 409,
            response: errorBody(
              'ONBOARDING_NOT_READY',
              'The current onboarding deployment is not ready.',
            ),
          };
        }
        await authentication.markOnboardingCompleted({
          ...session,
          now: nowIso(),
        });
        return { statusCode: 200, response: { completed: true } };
      },
    });
    return true;
  }

  if (pathname === `${ROOT}/model-candidates`) {
    if (req.method !== 'POST') return wrongMethod(res, 'POST');
    const body = await readObject(req, res);
    if (!body) return true;
    if (
      typeof body.providerId !== 'string' ||
      !body.credentials ||
      typeof body.credentials !== 'object' ||
      Array.isArray(body.credentials)
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'A model provider and credentials are required.',
      );
      return true;
    }
    await withIdempotency({
      req,
      res,
      session,
      repository: onboarding,
      operation: 'model.stage',
      body,
      run: async () => ({
        statusCode: 201,
        response: {
          candidate: await onboarding.stageModelCredentialCandidate({
            appId: session.appId,
            userId: session.userId,
            providerId: body.providerId as string,
            authMode:
              typeof body.authMode === 'string' ? body.authMode : undefined,
            payload: body.credentials,
          }),
        },
      }),
    });
    return true;
  }

  const modelMatch = pathname.match(
    /^\/ui\/api\/onboarding\/model-candidates\/([^/]+)\/(check|verify|activate|cancel)$/,
  );
  if (modelMatch) {
    if (req.method !== 'POST') return wrongMethod(res, 'POST');
    const body = await readObject(req, res);
    if (!body) return true;
    const candidateId = decodeURIComponent(modelMatch[1]!);
    const action = modelMatch[2]!;
    await withIdempotency({
      req,
      res,
      session,
      repository: onboarding,
      operation: `model.${action}`,
      body: { candidateId, ...body },
      run: async () => {
        const candidate = await onboarding.getModelCredentialCandidate({
          appId: session.appId,
          userId: session.userId,
          id: candidateId,
        });
        if (!candidate) {
          return {
            statusCode: 404,
            response: errorBody('NOT_FOUND', 'Model candidate not found.'),
          };
        }
        if (action === 'cancel') {
          await onboarding.transitionModelCredentialCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'cancelled',
          });
          return {
            statusCode: 200,
            response: { candidate: { id: candidateId, state: 'cancelled' } },
          };
        }
        if (Date.parse(candidate.expiresAt) <= Date.now()) {
          await onboarding.transitionModelCredentialCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'expired',
          });
          return {
            statusCode: 409,
            response: errorBody(
              'CANDIDATE_EXPIRED',
              'The credential candidate expired.',
            ),
          };
        }
        if (action === 'activate') {
          if (typeof body.name !== 'string' || typeof body.title !== 'string') {
            return {
              statusCode: 400,
              response: errorBody(
                'INVALID_REQUEST',
                'Employee name and title are required.',
              ),
            };
          }
          const result = await onboarding.activateModelAndCreateEmployee({
            appId: session.appId,
            userId: session.userId,
            candidateId,
            name: body.name,
            title: body.title,
            responsibilities:
              typeof body.responsibilities === 'string'
                ? body.responsibilities
                    .split('\n')
                    .map((item) => item.trim())
                    .filter(Boolean)
                : [],
          });
          if (!result.desiredStateRevision) {
            throw new Error(
              'Employee activation did not produce a settings revision.',
            );
          }
          await ctx.syncSettingsFromProjection(session.appId as AppId, {
            requiredRevision: result.desiredStateRevision,
          });
          await onboarding.recordProjectionReceipt({
            appId: session.appId,
            revision: result.desiredStateRevision,
            status: 'applied',
          });
          return {
            statusCode: result.replayed ? 200 : 201,
            response: { agent: result },
          };
        }
        if (action === 'check') {
          await onboarding.transitionModelCredentialCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'validating',
          });
          await onboarding.transitionModelCredentialCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'checked',
            checks: [
              { id: 'credentials', label: 'Credentials', status: 'pass' },
            ],
          });
          return {
            statusCode: 200,
            response: {
              candidate: { id: candidateId, state: 'checked' },
            },
          };
        }
        const selection =
          typeof body.modelAlias === 'string'
            ? resolveModelSelectionForWorkload(body.modelAlias, 'chat')
            : { ok: false as const, message: 'A model alias is required.' };
        if (!selection.ok) {
          return {
            statusCode: 400,
            response: errorBody('INVALID_REQUEST', selection.message),
          };
        }
        if (selection.entry.modelRoute.id !== candidate.providerId) {
          return {
            statusCode: 400,
            response: errorBody(
              'INVALID_REQUEST',
              'The selected model does not belong to that provider.',
            ),
          };
        }
        const bound = await onboarding.bindModelSelectionForVerification({
          appId: session.appId,
          userId: session.userId,
          id: candidateId,
          modelAlias: body.modelAlias as string,
          routeId: selection.entry.modelRoute.id,
        });
        if (!bound) {
          return {
            statusCode: 409,
            response: errorBody(
              'CANDIDATE_STATE_CONFLICT',
              'The credential candidate changed. Check the credentials again.',
            ),
          };
        }
        try {
          const probe = await verifyOnboardingModelCredential({
            appId: session.appId as AppId,
            credential: candidateCredential(candidate),
            modelAlias: body.modelAlias as string,
          });
          const verifiedAt = nowIso();
          const verificationExpiresAt = new Date(
            Date.now() + ONBOARDING_VERIFICATION_TTL_MS,
          ).toISOString();
          const verifiedChecks = [
            { id: 'credentials', label: 'Credentials', status: 'pass' },
            { id: 'route', label: 'Model route', status: 'pass' },
            { id: 'inference', label: 'Live inference', status: 'pass' },
          ];
          await onboarding.transitionModelCredentialCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'verified',
            checks: verifiedChecks,
            verifiedAt,
            verificationExpiresAt,
            failureCode: null,
          });
          return {
            statusCode: 200,
            response: {
              candidate: {
                id: candidateId,
                state: 'verified',
                verifiedAt,
                verificationExpiresAt,
                checks: verifiedChecks,
                routeId: probe.routeId,
              },
            },
          };
        } catch (error) {
          const credentialRejected = isModelCredentialRejectedError(error);
          const failedChecks = [
            {
              id: 'credentials',
              label: 'Credentials',
              status: credentialRejected ? 'fail' : 'pass',
            },
            { id: 'route', label: 'Model route', status: 'pass' },
            { id: 'inference', label: 'Live inference', status: 'fail' },
          ];
          await onboarding.transitionModelCredentialCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'failed',
            checks: failedChecks,
            failureCode: 'MODEL_PROBE_FAILED',
          });
          return {
            statusCode: 422,
            response: errorBody(
              'MODEL_PROBE_FAILED',
              error instanceof Error
                ? error.message
                : 'Model verification failed.',
              { checks: failedChecks },
            ),
          };
        }
      },
    });
    return true;
  }

  if (pathname === `${ROOT}/provider-candidates`) {
    if (req.method !== 'POST') return wrongMethod(res, 'POST');
    const body = await readObject(req, res);
    if (!body) return true;
    if (
      body.providerId !== 'slack' ||
      typeof body.agentId !== 'string' ||
      !isStringRecord(body.credentials) ||
      !body.credentials.bot_token ||
      !body.credentials.app_token
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'Slack bot and app tokens are required.',
      );
      return true;
    }
    await withIdempotency({
      req,
      res,
      session,
      repository: onboarding,
      operation: 'provider.stage',
      body,
      run: async () => ({
        statusCode: 201,
        response: {
          candidate: await onboarding.stageSlackWorkspaceCandidate({
            appId: session.appId,
            userId: session.userId,
            agentId: body.agentId as string,
            providerId: 'slack',
            credentials: body.credentials as Record<string, string>,
          }),
        },
      }),
    });
    return true;
  }

  const providerMatch = pathname.match(
    /^\/ui\/api\/onboarding\/provider-candidates\/([^/]+)\/(validate|activate|cancel)$/,
  );
  if (providerMatch) {
    if (req.method !== 'POST') return wrongMethod(res, 'POST');
    const body = await readObject(req, res);
    if (!body) return true;
    const candidateId = decodeURIComponent(providerMatch[1]!);
    const action = providerMatch[2]!;
    await withIdempotency({
      req,
      res,
      session,
      repository: onboarding,
      operation: `provider.${action}`,
      body: { candidateId, ...body },
      run: async () => {
        const candidate = await onboarding.getSlackWorkspaceCandidate({
          appId: session.appId,
          userId: session.userId,
          id: candidateId,
        });
        if (!candidate) {
          return {
            statusCode: 404,
            response: errorBody('NOT_FOUND', 'Slack candidate not found.'),
          };
        }
        if (action === 'cancel') {
          await onboarding.transitionSlackWorkspaceCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'cancelled',
          });
          return {
            statusCode: 200,
            response: { candidate: { id: candidateId, state: 'cancelled' } },
          };
        }
        if (Date.parse(candidate.expiresAt) <= Date.now()) {
          await onboarding.transitionSlackWorkspaceCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'expired',
          });
          return {
            statusCode: 409,
            response: errorBody(
              'CANDIDATE_EXPIRED',
              'The Slack candidate expired.',
            ),
          };
        }
        if (action === 'validate') {
          await onboarding.transitionSlackWorkspaceCandidate({
            appId: session.appId,
            userId: session.userId,
            id: candidateId,
            state: 'validating',
          });
          try {
            const result = await validateSlackWorkspaceCandidate({
              botToken: candidate.credentials.bot_token!,
              appToken: candidate.credentials.app_token!,
            });
            const lease = await tryAcquireRuntimeAdvisoryLease(
              `onboarding:slack-app:${result.identity.appId}`,
            );
            if (!lease) {
              throw Object.assign(
                new Error(
                  'This Slack app is being validated by another setup.',
                ),
                { code: 'VALIDATION_LEASE_BUSY', checks: result.checks },
              );
            }
            try {
              const accounts =
                await storage.repositories.providerAccounts.listProviderAccounts(
                  session.appId as AppId,
                );
              const conflict = accounts.find(
                (account) =>
                  account.status === 'active' &&
                  account.externalIdentityRef?.value ===
                    `slack-app:${result.identity.appId}`,
              );
              if (conflict) {
                throw Object.assign(
                  new Error(
                    'This Slack app is already owned by another active Provider Account.',
                  ),
                  { code: 'SLACK_APP_ALREADY_OWNED', checks: result.checks },
                );
              }
              await onboarding.transitionSlackWorkspaceCandidate({
                appId: session.appId,
                userId: session.userId,
                id: candidateId,
                state: 'verified',
                checks: result.checks,
                externalIdentity: result.identity,
                verifiedAt: nowIso(),
                failureCode: null,
              });
              return {
                statusCode: 200,
                response: {
                  candidate: {
                    id: candidateId,
                    state: 'verified',
                    checks: result.checks,
                    workspace: {
                      id: result.identity.teamId,
                      name: result.identity.teamName ?? result.identity.teamId,
                    },
                  },
                },
              };
            } finally {
              await lease.release();
            }
          } catch (error) {
            const details = error as {
              code?: string;
              checks?: unknown[];
              missingScopes?: string[];
            };
            await onboarding.transitionSlackWorkspaceCandidate({
              appId: session.appId,
              userId: session.userId,
              id: candidateId,
              state: 'failed',
              checks: details.checks ?? [],
              failureCode: details.code ?? 'SLACK_VALIDATION_FAILED',
            });
            return {
              statusCode: 422,
              response: errorBody(
                details.code ?? 'SLACK_VALIDATION_FAILED',
                error instanceof Error
                  ? error.message
                  : 'Slack validation failed.',
                {
                  checks: details.checks ?? [],
                  missingScopes: details.missingScopes ?? [],
                },
              ),
            };
          }
        }
        if (candidate.state !== 'verified' || !candidate.externalIdentityJson) {
          return {
            statusCode: 409,
            response: errorBody(
              'SLACK_NOT_VERIFIED',
              'Validate Slack before activation.',
            ),
          };
        }
        const identity = candidate.externalIdentityJson as {
          appId: string;
          teamId: string;
          teamName?: string;
        };
        const accounts = new ProviderAccountControlService({
          agents: storage.repositories.agents,
          providerAccounts: storage.repositories.providerAccounts,
          providers: new BuiltInControlChannelProviderCatalog(),
          ids: { generate: randomUUID },
          clock: { now: nowIso },
        });
        const account = await accounts.create({
          appId: session.appId as AppId,
          agentId: candidate.agentId as AgentId,
          providerId: 'slack' as ProviderId,
          label: identity.teamName ?? 'Slack',
          externalInstallationRef: {
            kind: 'provider_account',
            value: `slack-app:${identity.appId}`,
          },
          enabled: false,
        });
        const secrets = new CapabilitySecretService(
          storage.repositories.capabilitySecrets,
          (event) => storage.runtimeEvents.publish(event),
        );
        const refs: Record<string, string> = {};
        for (const key of ['bot_token', 'app_token'] as const) {
          const name = runtimeSecretNameForProviderAccount(
            'slack',
            account.id,
            key,
          );
          await secrets.set({
            appId: session.appId as AppId,
            name,
            value: candidate.credentials[key]!,
            actor: { kind: 'human', personId: session.userId },
          });
          refs[key] = gantryRuntimeSecretRef(name);
        }
        const active = await accounts.update({
          appId: session.appId as AppId,
          providerAccountId: account.id,
          patch: { runtimeSecretRefs: refs, enabled: true },
        });
        await ctx.syncSettingsFromProjection(session.appId as AppId, {
          providerAccount: { id: active.id, runtimeSecretRefs: refs },
        });
        await ctx.connectProjectedChannels?.();
        const latest =
          await storage.repositories.settingsRevisions.getLatestSettingsRevision(
            session.appId,
          );
        if (!latest)
          throw new Error(
            'Slack activation did not produce a settings revision.',
          );
        await onboarding.recordSlackWorkspaceActivation({
          appId: session.appId,
          userId: session.userId,
          candidateId,
          providerAccountId: active.id,
          desiredStateRevision: latest.revision,
        });
        await onboarding.recordProjectionReceipt({
          appId: session.appId,
          revision: latest.revision,
          status: 'applied',
        });
        return {
          statusCode: 201,
          response: {
            account: {
              id: active.id,
              providerId: active.providerId,
              label: active.label,
              status: active.status,
            },
          },
        };
      },
    });
    return true;
  }

  if (pathname === `${ROOT}/assignment`) {
    if (req.method !== 'POST') return wrongMethod(res, 'POST');
    const body = await readObject(req, res);
    if (!body) return true;
    if (
      typeof body.conversationId !== 'string' ||
      typeof body.approverExternalUserId !== 'string'
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'One conversation and one approver are required.',
      );
      return true;
    }
    await withIdempotency({
      req,
      res,
      session,
      repository: onboarding,
      operation: 'assignment.bind',
      body,
      run: async () => {
        const status = await onboarding.status({
          appId: session.appId,
          userId: session.userId,
          completedAt: null,
        });
        const deployment = status.deployment;
        if (!deployment?.agentId || !deployment.providerAccountId) {
          return {
            statusCode: 409,
            response: errorBody('SLACK_NOT_CONNECTED', 'Connect Slack first.'),
          };
        }
        const conversationId = body.conversationId as ConversationId;
        const approverId = body.approverExternalUserId as string;
        const admin = createBrowserConversationAdministrationService(
          session.appId as AppId,
        );
        const members = await admin.listConversationMembers({
          appId: session.appId as AppId,
          conversationId,
        });
        const approver = members.find((member) => member.id === approverId);
        if (!approver) {
          return {
            statusCode: 422,
            response: errorBody(
              'APPROVER_NOT_ELIGIBLE',
              'The approver must be an internal human member of the conversation.',
            ),
          };
        }
        const assignment = await onboarding.bindWorkAssignment({
          appId: session.appId as AppId,
          userId: session.userId,
          agentId: deployment.agentId as AgentId,
          providerAccountId: deployment.providerAccountId as ProviderAccountId,
          conversationId,
          approverExternalUserId: approver.id,
          approverDisplayName: approver.displayName,
        });
        await ctx.syncSettingsFromProjection(session.appId as AppId);
        const latest =
          await storage.repositories.settingsRevisions.getLatestSettingsRevision(
            session.appId,
          );
        if (!latest)
          throw new Error('Assignment did not produce a settings revision.');
        const updated = await onboarding.recordSlackWorkAssignment({
          appId: session.appId,
          userId: session.userId,
          conversationId,
          approverPersonId: assignment.approverPersonId,
          desiredStateRevision: latest.revision,
        });
        await onboarding.recordProjectionReceipt({
          appId: session.appId,
          revision: latest.revision,
          status: 'applied',
        });
        return {
          statusCode: 200,
          response: {
            assignment: {
              conversationId,
              approverPersonId: assignment.approverPersonId,
              deploymentVersion: updated.version,
              state: 'verification_required',
            },
          },
        };
      },
    });
    return true;
  }

  if (pathname === `${ROOT}/challenge`) {
    if (req.method !== 'POST') return wrongMethod(res, 'GET, POST');
    const body = await readObject(req, res);
    if (!body) return true;
    await withIdempotency({
      req,
      res,
      session,
      repository: onboarding,
      operation: 'challenge.create',
      body,
      run: async () => {
        const status = await onboarding.status({
          appId: session.appId,
          userId: session.userId,
          completedAt: null,
        });
        const agent = status.deployment?.agentId
          ? await storage.repositories.agents.getAgent(
              status.deployment.agentId as AgentId,
            )
          : null;
        if (!agent) {
          return {
            statusCode: 409,
            response: errorBody(
              'AGENT_NOT_CREATED',
              'Create the employee first.',
            ),
          };
        }
        const nonce = randomUUID().slice(0, 8).toUpperCase();
        const handle =
          agent.name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'agent';
        const challenge = await onboarding.createChallenge({
          appId: session.appId,
          userId: session.userId,
          challengeText: `@${handle} are you there? · ${nonce}`,
        });
        return { statusCode: 201, response: { challenge } };
      },
    });
    return true;
  }

  sendError(res, 404, 'NOT_FOUND', 'Onboarding route not found.');
  return true;
}

async function requireAdministratorRead(
  req: IncomingMessage,
  res: ServerResponse,
  mode: 'local' | 'hosted',
) {
  const session = await activeSession(req, mode);
  if (!session) {
    sendError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return null;
  }
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'agents:admin')) {
    sendError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return null;
  }
  return session;
}

async function readObject(req: IncomingMessage, res: ServerResponse) {
  try {
    const value = await readJson(req);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Request body must be a JSON object.',
    );
    return null;
  }
}

async function withIdempotency(input: {
  req: IncomingMessage;
  res: ServerResponse;
  session: { appId: string; userId: string };
  repository: PostgresOnboardingLifecycleRepository;
  operation: string;
  body: unknown;
  run: () => Promise<{ statusCode: number; response: unknown }>;
}) {
  const raw = input.req.headers['idempotency-key'];
  const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!key) {
    sendError(
      input.res,
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key is required.',
    );
    return;
  }
  const requestHash = stableSha256Json(input.body);
  try {
    const replay = await input.repository.operationReplay({
      ...input.session,
      operation: input.operation,
      idempotencyKey: key,
      requestHash,
    });
    if (replay) {
      sendJson(input.res, replay.statusCode, replay.response);
      return;
    }
    const result = await input.run();
    await input.repository.saveOperation({
      ...input.session,
      operation: input.operation,
      idempotencyKey: key,
      requestHash,
      statusCode: result.statusCode,
      response: result.response,
    });
    sendJson(input.res, result.statusCode, result.response);
  } catch (error) {
    if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') {
      sendError(
        input.res,
        409,
        'IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with different input.',
      );
      return;
    }
    sendError(
      input.res,
      400,
      'ONBOARDING_OPERATION_FAILED',
      error instanceof Error ? error.message : 'Onboarding operation failed.',
    );
  }
}

function candidateCredential(
  candidate: NonNullable<
    Awaited<
      ReturnType<
        PostgresOnboardingLifecycleRepository['getModelCredentialCandidate']
      >
    >
  >,
) {
  return {
    id: `onboarding-model-candidate:${candidate.id}`,
    appId: candidate.appId,
    providerId: candidate.providerId,
    authMode: candidate.authMode,
    schemaVersion: candidate.schemaVersion,
    payload: candidate.payload,
    status: 'active',
    fingerprint: `candidate:${candidate.requestHash.slice(0, 16)}`,
    fieldFingerprints: [],
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  } as unknown as ModelCredential;
}

function wrongMethod(res: ServerResponse, allow: string): true {
  res.setHeader('Allow', allow);
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  return true;
}

function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string'),
  );
}
