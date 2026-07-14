import type { PermissionPromotionRepository } from '../../domain/ports/permission-promotion.js';
import type {
  PermissionApprovalRequest,
  PermissionApprovalUpdate,
} from '../../domain/types.js';
import { nowIso } from '../../shared/time/datetime.js';

export const PERMISSION_PROMOTION_ALLOW_THRESHOLD = 3;

export interface PermissionPromotionInput {
  repository: PermissionPromotionRepository;
  appId: string;
  agentId?: string;
  agentFolder: string;
  suggestionKey: string;
  suggestions: PermissionApprovalUpdate[];
  toolName: string;
  targetJid?: string;
  threadId?: string;
  offer(request: PermissionApprovalRequest): Promise<unknown>;
  now?: () => string;
  requestId?: () => string;
}

export function schedulePermissionPromotion(
  input: PermissionPromotionInput,
  warn: (context: Record<string, unknown>, message: string) => void,
): void {
  void processPermissionPromotion(input).catch((error) =>
    warn(
      {
        error,
        appId: input.appId,
        agentFolder: input.agentFolder,
        suggestionKey: input.suggestionKey,
      },
      'Permission promotion processing failed',
    ),
  );
}

export async function processPermissionPromotion(
  input: PermissionPromotionInput,
): Promise<void> {
  const currentTime = input.now ?? nowIso;
  const counter = await input.repository.incrementAndGet({
    appId: input.appId,
    agentFolder: input.agentFolder,
    suggestionKey: input.suggestionKey,
    nowIso: currentTime(),
  });
  if (
    counter.allowCount < PERMISSION_PROMOTION_ALLOW_THRESHOLD ||
    counter.lastOfferedAt
  ) {
    return;
  }
  const offeredAt = currentTime();
  const claimed = await input.repository.markOffered({
    appId: input.appId,
    agentFolder: input.agentFolder,
    suggestionKey: input.suggestionKey,
    nowIso: offeredAt,
  });
  if (!claimed) return;
  await input.offer({
    requestId:
      input.requestId?.() ??
      `permission-promotion-${globalThis.crypto.randomUUID()}`,
    requestFamily: 'promotion',
    sourceAgentFolder: input.agentFolder,
    appId: input.appId,
    agentId: input.agentId,
    targetJid: input.targetJid,
    threadId: input.threadId,
    toolName: input.toolName,
    displayName: input.toolName,
    description: `I've auto-allowed ${input.toolName} ${PERMISSION_PROMOTION_ALLOW_THRESHOLD} times in this conversation — make it permanent?`,
    decisionReason:
      'Repeated classifier auto-allows are eligible for a durable rule.',
    suggestions: input.suggestions,
    decisionOptions: ['allow_persistent_rule', 'cancel'],
  });
}
