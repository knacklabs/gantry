import { PermissionClassifierStatus } from '../../domain/permission-classifier-status.js';

export const JUDGE_OFFLINE_REASON =
  'Asking because my safety judge is offline.';

export interface JudgeOutageLatchKey {
  appId: string;
  providerAccountId?: string;
  targetJid?: string;
}

/** Opens once per outage per conversation, so the outage is logged once rather than per call. */
export function createJudgeOutageLatch() {
  const openKeys = new Set<string>();
  const keyFor = ({
    appId,
    providerAccountId,
    targetJid,
  }: JudgeOutageLatchKey) =>
    `${appId}\u0000${providerAccountId ?? ''}\u0000${targetJid ?? ''}`;

  return {
    observe(status: PermissionClassifierStatus, key: JudgeOutageLatchKey) {
      const value = keyFor(key);
      if (status === PermissionClassifierStatus.Unavailable) {
        if (openKeys.has(value)) return { logDue: false };
        openKeys.add(value);
        return { logDue: true };
      }
      if (status === PermissionClassifierStatus.Answered)
        openKeys.delete(value);
      return { logDue: false };
    },
    reset(key: JudgeOutageLatchKey) {
      openKeys.delete(keyFor(key));
    },
    clearAll() {
      openKeys.clear();
    },
  };
}
