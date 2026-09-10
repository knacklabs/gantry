import { PermissionClassifierStatus } from '../../domain/permission-classifier-status.js';

export const JUDGE_OFFLINE_NOTICE =
  "My safety judge is offline, so I'll check with you more than usual until it's back.";
export const JUDGE_OFFLINE_REASON =
  'Asking because my safety judge is offline.';

export interface JudgeOutageLatchKey {
  appId: string;
  providerAccountId?: string;
  targetJid?: string;
}

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
        if (openKeys.has(value)) return { noticeDue: false };
        openKeys.add(value);
        return { noticeDue: true };
      }
      if (status === PermissionClassifierStatus.Answered)
        openKeys.delete(value);
      return { noticeDue: false };
    },
    reset(key: JudgeOutageLatchKey) {
      openKeys.delete(keyFor(key));
    },
    clearAll() {
      openKeys.clear();
    },
  };
}
