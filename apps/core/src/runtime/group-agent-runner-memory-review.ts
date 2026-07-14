import type { GroupProcessingDeps } from './group-processing-types.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';

const MEMORY_REVIEW_APPROVER_CACHE_TTL_MS = 60_000;
const memoryReviewApproverCache = new Map<string, [boolean, number]>();

export async function memoryReviewerApproverAllowed(
  deps: GroupProcessingDeps,
  conversationJid: string,
  sourceAgentFolder: string,
  userId?: string,
): Promise<boolean> {
  if (!userId) return false;
  const hook = deps.channelRuntime.isControlApproverAllowed;
  if (!hook) return false;
  const key = `${conversationJid}\0${sourceAgentFolder}\0${userId}`;
  const now = currentTimeMs();
  const cached = memoryReviewApproverCache.get(key);
  if (cached && cached[1] > now) return cached[0];
  const allowed =
    (await hook({
      conversationJid,
      userId,
      sourceAgentFolder,
      decisionPolicy: 'same_channel',
    }).catch(() => false)) === true;
  memoryReviewApproverCache.set(key, [
    allowed,
    now + MEMORY_REVIEW_APPROVER_CACHE_TTL_MS,
  ]);
  return allowed;
}
