import type { PendingInteractionKind } from '../../domain/ports/worker-coordination.js';

const DEFAULT_APP_ID = 'default';

export function pendingInteractionIdempotencyKey(input: {
  kind: PendingInteractionKind;
  sourceAgentFolder: string;
  requestId: string;
  appId?: string | null;
}): string {
  return [
    input.appId || DEFAULT_APP_ID,
    input.kind,
    input.sourceAgentFolder,
    input.requestId,
  ].join(':');
}
