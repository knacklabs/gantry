import type { PermissionPromotionRepository } from '../../domain/ports/permission-promotion.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';

export const PERMISSION_PROMOTION_ALLOW_THRESHOLD = 2;

export interface PermissionPromotionInput {
  repository: PermissionPromotionRepository;
  offer(request: PermissionApprovalRequest): Promise<unknown>;
}
