import fs from 'fs';
import path from 'path';

// Permission request authentication must remain valid for the entire durable
// pending-interaction retention window. One bound drives both so they cannot
// drift apart.
export const IPC_INTERACTION_RETENTION_TTL_MS = 24 * 60 * 60_000;

export type IpcRequestClaimProbe = (requestPath: string) => boolean;

const filesystemIpcRequestClaimProbe: IpcRequestClaimProbe = (requestPath) => {
  const requestFile = path.basename(requestPath);
  return fs
    .readdirSync(path.dirname(requestPath))
    .some(
      (file) =>
        file.startsWith('.processing-') && file.endsWith(`-${requestFile}`),
    );
};

export function hasIpcRequestClaimMarker(
  requestPath: string,
  probe: IpcRequestClaimProbe = filesystemIpcRequestClaimProbe,
): boolean {
  try {
    return probe(requestPath);
  } catch {
    return false;
  }
}

export function ipcInteractionAuthEnvelopeOptions(unbounded: boolean): {
  separateAuthExpiry: true;
  authLifetimeMs?: number;
  authPurpose?: 'unbounded-interaction';
} {
  return {
    separateAuthExpiry: true,
    ...(unbounded
      ? {
          authLifetimeMs: IPC_INTERACTION_RETENTION_TTL_MS,
          authPurpose: 'unbounded-interaction' as const,
        }
      : {}),
  };
}

export function ipcInteractionAuthValidationOptions(_permissionLane: unknown):
  | {
      extendedAuthPurpose: 'unbounded-interaction';
      extendedMaxAgeMs: number;
    }
  | undefined {
  return {
    extendedAuthPurpose: 'unbounded-interaction',
    extendedMaxAgeMs: IPC_INTERACTION_RETENTION_TTL_MS,
  };
}

export function ipcInteractionUnclaimableReason(
  kind: 'permission' | 'question',
): string {
  return kind === 'permission'
    ? 'Permission request could not be claimed before its authenticated ingestion window expired. Retry the live request.'
    : 'Question could not be claimed before its authenticated ingestion window expired. Please ask again.';
}

export function ipcQuestionWaitExpiredReason(permissionLane: unknown): string {
  return permissionLane === 'interactive'
    ? ipcInteractionUnclaimableReason('question')
    : 'Question expired. Please ask again if this is still needed.';
}
