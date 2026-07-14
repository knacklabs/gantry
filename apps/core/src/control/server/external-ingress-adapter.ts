import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { ConversationMessageIngressModule } from '../../application/external-ingress/conversation-message-ingress.js';
import {
  providerIdForJid,
  providerJidPrefix,
} from '../../channels/provider-registry.js';
import { ApplicationError } from '../../application/common/application-error.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../../application/jobs/job-access.js';
import { ExternalIngressModule } from '../../application/external-ingress/external-ingress-module.js';
import { EXTERNAL_INGRESS_RUNTIME_DISPATCH } from '../../application/external-ingress/runtime-dispatch.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import type { ProviderAccountId } from '../../domain/provider/provider.js';
import {
  findConversationRoutesForChat,
  makeAgentThreadQueueKey,
  makeThreadQueueKey,
  parseAgentThreadQueueKey,
} from '../../shared/thread-queue-key.js';
import { SessionInteractionModule } from '../../application/sessions/session-interaction-module.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import { nowIso } from './app-identity.js';
import type { ControlRouteContext } from './handler-context.js';
import {
  TRIGGER_RATE_LIMIT_PER_APP,
  TRIGGER_RATE_LIMIT_PER_JOB,
} from './rate-limit.js';
import { adaptSessionControlPort } from './session-control-port.js';
import { createJobManagementService } from './routes/jobs.js';

export function hasRouteForConversation(
  routes: Record<string, unknown>,
  conversationJid: string,
  threadId?: string | null,
  providerAccountId?: string | null,
): boolean {
  return (
    findConversationRoutesForChat(
      routes,
      conversationJid,
      threadId,
      providerAccountId,
    ).length > 0
  );
}

export function resolveConversationMessageRoute(
  routes: Record<string, unknown>,
  conversationJid: string,
  threadId: string | null,
  providerAccountId?: string | null,
  agentId?: string | null,
): { agentId?: string | null; queueKey: string } | null {
  const normalizedAgentId = agentId?.trim() || null;
  const matches = findConversationRoutesForChat(
    routes,
    conversationJid,
    threadId,
    providerAccountId,
  ).map(([key, route]) => {
    const parsed = parseAgentThreadQueueKey(key);
    return {
      parsed,
      agentId: parsed.agentId ?? routeAgentId(route),
    };
  });
  if (matches.length === 0) return null;
  if (normalizedAgentId) {
    if (!matches.some((match) => match.agentId === normalizedAgentId)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'target.agentId does not match an active route for this conversation/thread',
      );
    }
    return {
      agentId: normalizedAgentId,
      queueKey: makeAgentThreadQueueKey(
        conversationJid,
        normalizedAgentId,
        threadId,
        providerAccountId,
      ),
    };
  }

  const agentIds = new Set(
    matches
      .map((match) => match.agentId)
      .filter((value): value is string => !!value),
  );
  if (agentIds.size > 1) {
    throw new ApplicationError(
      'CONFLICT',
      'Multiple agent routes match this conversation/thread; provide target.agentId.',
    );
  }
  const [resolvedAgentId] = [...agentIds];
  return resolvedAgentId
    ? {
        agentId: resolvedAgentId,
        queueKey: makeAgentThreadQueueKey(
          conversationJid,
          resolvedAgentId,
          threadId,
          providerAccountId,
        ),
      }
    : {
        agentId: null,
        queueKey: makeThreadQueueKey(conversationJid, threadId),
      };
}

function routeAgentId(route: unknown): string | null {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
  const folder = (route as { folder?: unknown }).folder;
  return typeof folder === 'string' && folder.trim()
    ? agentIdForFolder(folder)
    : null;
}

export function createExternalIngressModule(
  ctx: ControlRouteContext,
): ExternalIngressModule {
  const control = getRuntimeControlRepository();
  const liveAdmissionAppId =
    ctx.liveTurnsEnabled === false ? null : DEFAULT_JOB_RUNTIME_APP_ID;
  const sessions = new SessionInteractionModule({
    control: adaptSessionControlPort(control),
    ops: getRuntimeRepositories(),
    repositories: getRuntimeStorage().repositories,
    runtimeEvents: getRuntimeEventExchange(),
    liveAdmissionAppId,
    now: nowIso,
    createId: randomUUID,
    stableHash: (input) => createHash('sha256').update(input).digest('hex'),
  });
  const conversationMessages = new ConversationMessageIngressModule({
    conversations: getRuntimeStorage().repositories.conversations,
    ops: getRuntimeRepositories(),
    runtimeEvents: getRuntimeEventExchange(),
    liveAdmissionAppId,
    isConversationRoutable: (conversationJid, threadId, providerAccountId) =>
      hasRouteForConversation(
        ctx.app.getConversationRoutes(),
        conversationJid,
        threadId,
        providerAccountId,
      ),
    resolveProviderJidPrefix: async (providerAccountId) => {
      const account =
        await getRuntimeStorage().repositories.providerAccounts.getProviderAccount(
          providerAccountId as ProviderAccountId,
        );
      return account ? providerJidPrefix(account.providerId) || null : null;
    },
    providerForConversationJid: (conversationJid) =>
      providerIdForJid(conversationJid, 'app'),
    makeQueueKey: makeThreadQueueKey,
    resolveRoute: ({ conversationJid, threadId, agentId, providerAccountId }) =>
      resolveConversationMessageRoute(
        ctx.app.getConversationRoutes(),
        conversationJid,
        threadId,
        providerAccountId,
        agentId,
      ),
    messageReactions: ctx.addMessageReaction
      ? { addReaction: ctx.addMessageReaction }
      : undefined,
    now: nowIso,
    createId: randomUUID,
  });
  return new ExternalIngressModule({
    control,
    sessions,
    registerSessionGroup: (registration) =>
      ctx.app.registerGroup(registration.conversationJid, registration.group),
    conversationMessages,
    conversationProviderMessages: ctx.sendConversationIngressProjection
      ? {
          send: ctx.sendConversationIngressProjection,
        }
      : undefined,
    jobs: createJobManagementService(ctx),
    now: nowIso,
    createSecret: () => randomBytes(32).toString('hex'),
    createInvocationId: randomUUID,
    signatureCrypto: nodeSignatureCrypto,
    consumeTriggerRateLimit: (key, limit) =>
      ctx.triggerRateLimiter.consume(key, limit),
    perAppTriggerLimit: TRIGGER_RATE_LIMIT_PER_APP,
    perJobTriggerLimit: TRIGGER_RATE_LIMIT_PER_JOB,
  });
}

export async function invokeExternalIngressForControl(
  ctx: ControlRouteContext,
  input: Parameters<ExternalIngressModule['invoke']>[0],
): Promise<Awaited<ReturnType<ExternalIngressModule['invoke']>>> {
  const result = await createExternalIngressModule(ctx).invoke(input);
  const runtimeDispatch = (result as Record<PropertyKey, unknown>)[
    EXTERNAL_INGRESS_RUNTIME_DISPATCH
  ];
  const hasRuntimeDispatch =
    runtimeDispatch !== null && typeof runtimeDispatch === 'object';
  const runtimeEnqueue = hasRuntimeDispatch
    ? (runtimeDispatch as { enqueue?: { queueKey?: unknown } }).enqueue
    : undefined;
  const localEnqueue =
    !hasRuntimeDispatch ||
    (runtimeDispatch as { localEnqueue?: unknown }).localEnqueue !== false;
  if (
    'registerGroup' in result &&
    result.registerGroup &&
    typeof result.registerGroup === 'object' &&
    'conversationJid' in result.registerGroup &&
    typeof result.registerGroup.conversationJid === 'string' &&
    'group' in result.registerGroup
  ) {
    await ctx.app.registerGroup(
      result.registerGroup.conversationJid,
      result.registerGroup.group as never,
    );
  }
  if (
    localEnqueue &&
    runtimeEnqueue &&
    typeof runtimeEnqueue === 'object' &&
    typeof runtimeEnqueue.queueKey === 'string'
  ) {
    ctx.app.queue.enqueueMessageCheck(runtimeEnqueue.queueKey);
  }
  if (
    !hasRuntimeDispatch &&
    !(
      ctx.liveTurnsEnabled !== false &&
      'targetKind' in result &&
      result.targetKind === 'session_message'
    ) &&
    'enqueue' in result &&
    result.enqueue &&
    typeof result.enqueue === 'object' &&
    'queueKey' in result.enqueue &&
    typeof result.enqueue.queueKey === 'string'
  ) {
    ctx.app.queue.enqueueMessageCheck(result.enqueue.queueKey);
  }
  return result;
}

const nodeSignatureCrypto = {
  sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  },
  hmacSha256(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  },
  constantTimeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return (
      leftBuffer.length === rightBuffer.length &&
      timingSafeEqual(leftBuffer, rightBuffer)
    );
  },
};
