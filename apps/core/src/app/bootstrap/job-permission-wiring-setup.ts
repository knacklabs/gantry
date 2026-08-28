import { createHash } from 'node:crypto';

import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type { WorkerCoordinationRepository } from '../../domain/ports/worker-coordination.js';
import type {
  ToolCatalogRepository,
  SkillCatalogRepository,
} from '../../domain/ports/repositories.js';
import type {
  JobPermissionCardRetireDelivery,
  MessageActionAffordance,
  MessageSendOptions,
} from '../../domain/types.js';
import { parseJobPermissionCardAction } from '../../domain/job-permission-card-actions.js';
import { enqueueJobTrigger } from '../../jobs/scheduler.js';
import { configureJobPermissionLeaseExtensionReader } from '../../jobs/execution-lease.js';
import { createJobPermissionDurabilityWiring } from './job-permission-durability-wiring.js';
import { startRuntimePermissionCardReconciliation } from './runtime-services-permission-card.js';
import { registerRuntimeLiveStopMessageAction } from './runtime-live-stop-message-action.js';
import type { RuntimeApp } from './runtime-app.js';
import {
  canonicalThreadIdFor,
  resolveDurableOutboundTarget,
} from './runtime-services-destination-hints.js';
import type {
  ChannelWiring,
  RecoveryDispatchPermit,
} from './channel-wiring-types.js';

interface JobPermissionCardPayload {
  actions: MessageActionAffordance[];
  callbackKey: string;
  revision: number;
  operation: 'send' | 'edit' | 'retire' | 'replace';
  providerMessageId: string | null;
  retireOutcome?: 'allowed' | 'expired';
  retiredRows?: Array<{ label: string }>;
  retireDelivery?: JobPermissionCardRetireDelivery;
}

function jobPermissionStableUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function parseJobPermissionCardPayload(
  value: unknown,
): JobPermissionCardPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as {
    actions?: unknown;
    callbackKey?: unknown;
    revision?: unknown;
    operation?: unknown;
    providerMessageId?: unknown;
    retireOutcome?: unknown;
    retiredRows?: unknown;
    retireDelivery?: unknown;
  };
  if (!Array.isArray(raw.actions)) return null;
  if (typeof raw.callbackKey !== 'string' || !raw.callbackKey.trim()) {
    return null;
  }
  if (
    typeof raw.revision !== 'number' ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 0
  ) {
    return null;
  }
  if (!['send', 'edit', 'retire', 'replace'].includes(String(raw.operation))) {
    return null;
  }
  const providerMessageId =
    typeof raw.providerMessageId === 'string' && raw.providerMessageId.trim()
      ? raw.providerMessageId.trim()
      : null;
  if (
    (raw.operation === 'edit' || raw.operation === 'retire') &&
    !providerMessageId
  ) {
    return null;
  }
  const retireOutcome = raw.retireOutcome;
  if (
    retireOutcome !== undefined &&
    retireOutcome !== 'allowed' &&
    retireOutcome !== 'expired'
  ) {
    return null;
  }
  let retiredRows: Array<{ label: string }> | undefined;
  if (raw.retiredRows !== undefined) {
    if (!Array.isArray(raw.retiredRows)) return null;
    retiredRows = [];
    for (const row of raw.retiredRows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const label = (row as { label?: unknown }).label;
      if (typeof label !== 'string' || !label.trim()) return null;
      retiredRows.push({ label: label.trim() });
    }
  }
  let retireDelivery: JobPermissionCardRetireDelivery | undefined;
  if (raw.retireDelivery !== undefined) {
    if (
      !raw.retireDelivery ||
      typeof raw.retireDelivery !== 'object' ||
      Array.isArray(raw.retireDelivery)
    ) {
      return null;
    }
    const delivery = raw.retireDelivery as {
      deleteFailedAt?: unknown;
      deletedAt?: unknown;
      receiptMessageId?: unknown;
    };
    const deleteFailedAt =
      typeof delivery.deleteFailedAt === 'string' &&
      delivery.deleteFailedAt.trim()
        ? delivery.deleteFailedAt.trim()
        : undefined;
    const deletedAt =
      typeof delivery.deletedAt === 'string' && delivery.deletedAt.trim()
        ? delivery.deletedAt.trim()
        : undefined;
    const receiptMessageId =
      typeof delivery.receiptMessageId === 'string' &&
      delivery.receiptMessageId.trim()
        ? delivery.receiptMessageId.trim()
        : undefined;
    if (
      (!deleteFailedAt && !deletedAt && !receiptMessageId) ||
      (deletedAt && (deleteFailedAt || receiptMessageId))
    ) {
      return null;
    }
    retireDelivery = {
      ...(deleteFailedAt ? { deleteFailedAt } : {}),
      ...(deletedAt ? { deletedAt } : {}),
      ...(receiptMessageId ? { receiptMessageId } : {}),
    };
  }
  const actions: MessageActionAffordance[] = [];
  for (const action of raw.actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      return null;
    }
    const token = (action as { token?: unknown }).token;
    const label = (action as { label?: unknown }).label;
    if (
      typeof token !== 'string' ||
      !parseJobPermissionCardAction(token) ||
      typeof label !== 'string' ||
      !label.trim()
    ) {
      return null;
    }
    actions.push({
      kind: 'job_permission_decision',
      label: label.trim(),
      actionToken: token,
    });
  }
  return {
    actions,
    callbackKey: raw.callbackKey.trim(),
    revision: raw.revision,
    operation: raw.operation as JobPermissionCardPayload['operation'],
    providerMessageId,
    ...(retireOutcome ? { retireOutcome } : {}),
    ...(retiredRows ? { retiredRows } : {}),
    ...(retireDelivery ? { retireDelivery } : {}),
  };
}

export function setupJobPermissionDurability(input: {
  workerCoordination: WorkerCoordinationRepository | undefined;
  opsRepository: RuntimeJobRepository;
  channelWiring: ChannelWiring;
  getPermissionRuntimeSettings: Parameters<
    typeof createJobPermissionDurabilityWiring
  >[0]['getPermissionRuntimeSettings'];
  getToolRepository: () => ToolCatalogRepository | undefined;
  getSkillRepository: () => SkillCatalogRepository | undefined;
  createJobTrigger: (request: {
    jobId: string;
    triggerId: string;
    requestedBy: string;
  }) => Promise<{ status: string; triggerId: string }>;
}) {
  const service = input.workerCoordination
    ? createJobPermissionDurabilityWiring({
        repository: input.workerCoordination,
        opsRepository: input.opsRepository,
        channelWiring: input.channelWiring,
        getPermissionRuntimeSettings: input.getPermissionRuntimeSettings,
        getToolRepository: input.getToolRepository,
        getSkillRepository: input.getSkillRepository,
        resolveCardTarget: (request) => {
          const targetJid = request.targetJid?.trim();
          if (!targetJid) {
            throw new Error('Job permission card target is unavailable.');
          }
          const target = resolveDurableOutboundTarget({
            defaultAppId:
              request.appId ?? String(input.channelWiring.getRuntimeAppId()),
            jid: targetJid,
            providerAccountId: request.providerAccountId,
          });
          return {
            ...target,
            threadId:
              canonicalThreadIdFor({
                jid: targetJid,
                threadId: request.threadId,
                providerAccountId: request.providerAccountId,
              }) ?? null,
            agentId: request.agentId ?? null,
          };
        },
        enqueueRunAgain: async (request) => {
          const triggerId = jobPermissionStableUuid(
            `${request.idempotencyKey}:trigger`,
          );
          const runId = jobPermissionStableUuid(
            `${request.idempotencyKey}:run`,
          );
          const trigger = await input.createJobTrigger({
            jobId: request.jobId,
            triggerId,
            requestedBy: JSON.stringify({
              kind: 'job_permission_handoff',
              idempotencyKey: request.idempotencyKey,
              priorRunId: request.priorRunId,
            }),
          });
          if (trigger.status === 'pending') {
            await enqueueJobTrigger(request.jobId, trigger.triggerId, {
              runId,
            });
          }
        },
      })
    : undefined;
  configureJobPermissionLeaseExtensionReader(
    service ? (request) => service.recordPendingHeartbeat(request) : null,
  );
  return service;
}

export function jobPermissionCardActionDeps(
  service: ReturnType<typeof setupJobPermissionDurability>,
) {
  type Action = Parameters<
    NonNullable<
      NonNullable<
        Parameters<typeof registerRuntimeLiveStopMessageAction>[3]
      >['decideJobPermission']
    >
  >[0];
  return service
    ? {
        decideJobPermission: (action: Action) =>
          service.decideCardAction({
            actor: {
              actorRef: action.userId!,
              conversationJid: action.conversationJid,
              providerAccountId: action.providerAccountId,
              threadId: action.threadId,
            },
            providerMessageId: action.messageId,
            token: action.actionToken,
          }),
      }
    : undefined;
}

export function startJobPermCards(
  ...args: Parameters<typeof startRuntimePermissionCardReconciliation>
): void {
  startRuntimePermissionCardReconciliation(...args);
}

export function wireJobPermissionActions(
  channelWiring: Parameters<typeof registerRuntimeLiveStopMessageAction>[0],
  app: RuntimeApp,
  liveMessageQueue: Parameters<typeof registerRuntimeLiveStopMessageAction>[2],
  service: ReturnType<typeof setupJobPermissionDurability>,
): void {
  registerRuntimeLiveStopMessageAction(
    channelWiring,
    app,
    liveMessageQueue,
    jobPermissionCardActionDeps(service),
  );
}

export async function sendJobPermCard(
  payload: Record<string, unknown> | undefined,
  claimed: {
    delivery: { id: string };
    item: { id: string; canonicalText: string };
  },
  createRecoveryDispatchPermit: ChannelWiring['createRecoveryDispatchPermit'],
  sendProviderMessage: ChannelWiring['sendProviderMessage'],
  destinationJid: string,
  destinationThreadId: string | undefined,
  destinationAccount: { providerAccountId: string },
  recoveryPermit: RecoveryDispatchPermit,
): Promise<
  | {
      status: 'failed';
      error: string;
    }
  | {
      status: 'sent';
      providerMessageId: string | undefined;
      providerPayload: Awaited<
        ReturnType<ChannelWiring['sendProviderMessage']>
      >;
    }
> {
  const card =
    payload?.jobPermissionCard === undefined
      ? undefined
      : parseJobPermissionCardPayload(payload.jobPermissionCard);
  if (card === null) {
    return {
      status: 'failed',
      error: 'Job-permission card payload is malformed.',
    };
  }
  if (card?.operation === 'replace' && card.providerMessageId) {
    const replacementNotice =
      'This permission card was replaced. Use the latest card for this job.';
    const replacementPermit = createRecoveryDispatchPermit({
      deliveryId: claimed.delivery.id,
      itemId: claimed.item.id,
      destinationJid,
      canonicalText: replacementNotice,
      ...(destinationThreadId ? { threadId: destinationThreadId } : {}),
    });
    await sendProviderMessage(destinationJid, replacementNotice, {
      permit: replacementPermit,
      throwOnMissing: true,
      messageOptions: {
        ...destinationAccount,
        ...(destinationThreadId ? { threadId: destinationThreadId } : {}),
        replaceMessageId: card.providerMessageId,
        // The new card, not this notice, must settle the replacement revision.
        actionAffordances: [],
      },
    });
  }
  const deliveryResult = await sendProviderMessage(
    destinationJid,
    claimed.item.canonicalText,
    {
      permit: recoveryPermit,
      throwOnMissing: true,
      messageOptions: {
        ...destinationAccount,
        ...(destinationThreadId ? { threadId: destinationThreadId } : {}),
        ...(payload?.observerDigestView
          ? {
              observerDigestView:
                payload.observerDigestView as MessageSendOptions['observerDigestView'],
            }
          : {}),
        ...(payload?.brainReviewView
          ? {
              brainReviewView:
                payload.brainReviewView as MessageSendOptions['brainReviewView'],
            }
          : {}),
        ...(card
          ? {
              actionAffordances: card.actions,
              jobPermissionCardRevision: {
                callbackKey: card.callbackKey,
                revision: card.revision,
                operation: card.operation,
                ...(card.retireOutcome
                  ? { retireOutcome: card.retireOutcome }
                  : {}),
                ...(card.retiredRows ? { retiredRows: card.retiredRows } : {}),
                ...(card.retireDelivery
                  ? { retireDelivery: card.retireDelivery }
                  : {}),
              },
              ...(card.operation === 'retire' &&
              card.retireOutcome === 'allowed' &&
              card.providerMessageId
                ? { deleteMessageId: card.providerMessageId }
                : (card.operation === 'edit' || card.operation === 'retire') &&
                    card.providerMessageId
                  ? { replaceMessageId: card.providerMessageId }
                  : {}),
            }
          : {}),
      },
    },
  );
  return {
    status: 'sent',
    providerMessageId: deliveryResult?.externalMessageId,
    providerPayload: deliveryResult,
  };
}
