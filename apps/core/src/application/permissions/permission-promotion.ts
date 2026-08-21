import type { PermissionPromotionRepository } from '../../domain/ports/permission-promotion.js';

export const PERMISSION_PROMOTION_ALLOW_THRESHOLD = 2;

export interface PermissionPromotionInput {
  repository: PermissionPromotionRepository;
}
