import type { PendingInteractionKind } from '../../domain/ports/worker-coordination.js';
import type { LiveTurnCommandRepository } from '../../domain/ports/live-turns.js';

export async function enqueueResolvedInteractionCommand(input: {
  liveTurns: Pick<LiveTurnCommandRepository, 'appendLiveTurnCommand'>;
  turnId: string;
  idempotencyKey: string;
  kind: PendingInteractionKind;
  requestId: string;
  sourceAgentFolder: string;
  status: 'resolved' | 'cancelled';
  resolution: Record<string, unknown>;
  callbackRoute: Record<string, unknown>;
  approverRef?: string | null;
}): Promise<boolean> {
  const appended = await input.liveTurns.appendLiveTurnCommand({
    id: globalThis.crypto.randomUUID(),
    liveTurnId: input.turnId,
    commandType: 'interaction_resolved',
    idempotencyKey: `interaction_resolved:${input.idempotencyKey}`,
    payload: {
      kind: input.kind,
      requestId: input.requestId,
      sourceAgentFolder: input.sourceAgentFolder,
      status: input.status,
      resolution: input.resolution,
      callbackRoute: input.callbackRoute,
      approverRef: input.approverRef ?? null,
    },
  });
  return appended.outcome !== 'rejected';
}
