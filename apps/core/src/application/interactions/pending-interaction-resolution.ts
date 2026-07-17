import type {
  PendingInteractionKind,
  PendingInteractionRepository,
} from '../../domain/ports/worker-coordination.js';
import type { LiveTurnRepository } from '../../domain/ports/live-turns.js';
import type { PermissionCallbackClaimReference } from '../../domain/types.js';

type InteractionLiveTurnRepository = Pick<
  LiveTurnRepository,
  'findActiveLiveTurnByRunId'
>;

export interface PendingInteractionResolutionBackend {
  repository: Pick<
    PendingInteractionRepository,
    'listPendingInteractions' | 'resolvePendingInteraction'
  >;
  liveTurns?: InteractionLiveTurnRepository | null;
  warn?: (context: Record<string, unknown>, message: string) => void;
}

export interface PendingInteractionResolutionInput {
  kind: PendingInteractionKind;
  sourceAgentFolder: string;
  requestId: string;
  idempotencyKey: string;
  appId: string;
  runId?: string | null;
  status: 'resolved' | 'cancelled';
  resolution: Record<string, unknown>;
  approverRef?: string | null;
  permissionCallbackClaim?: PermissionCallbackClaimReference | null;
}

export async function persistPendingInteractionResolution(
  active: PendingInteractionResolutionBackend,
  input: PendingInteractionResolutionInput,
): Promise<boolean> {
  let liveTurnDelivery: {
    turnId: string;
    callbackRoute: Record<string, unknown>;
  } | null = null;

  if (input.runId && active.liveTurns) {
    try {
      const pending = (
        await active.repository.listPendingInteractions({
          appId: input.appId,
          runId: input.runId,
        })
      ).find(
        (interaction) => interaction.idempotencyKey === input.idempotencyKey,
      );
      const turn = await active.liveTurns.findActiveLiveTurnByRunId({
        runId: input.runId,
      });
      if (turn && pending?.callbackRoute) {
        liveTurnDelivery = {
          turnId: turn.id,
          callbackRoute: pending.callbackRoute,
        };
      }
    } catch (err) {
      active.warn?.(
        {
          err,
          kind: input.kind,
          requestId: input.requestId,
          runId: input.runId,
        },
        'Failed to deliver interaction resolution to the owning live turn',
      );
      return false;
    }
  }

  try {
    const resolved = await active.repository.resolvePendingInteraction({
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      resolution: input.resolution,
      approverRef: input.approverRef ?? null,
      permissionCallbackClaim: input.permissionCallbackClaim ?? null,
      ...(liveTurnDelivery
        ? {
            liveTurnCommand: {
              id: globalThis.crypto.randomUUID(),
              liveTurnId: liveTurnDelivery.turnId,
              commandType: 'interaction_resolved',
              idempotencyKey: `interaction_resolved:${input.idempotencyKey}`,
              payload: {
                kind: input.kind,
                requestId: input.requestId,
                sourceAgentFolder: input.sourceAgentFolder,
                status: input.status,
                resolution: input.resolution,
                callbackRoute: liveTurnDelivery.callbackRoute,
                approverRef: input.approverRef ?? null,
              },
            },
          }
        : {}),
    });
    if (!resolved) return false;
  } catch (err) {
    active.warn?.(
      { err, kind: input.kind, requestId: input.requestId },
      'Failed to resolve durable pending interaction',
    );
    return false;
  }
  return true;
}
