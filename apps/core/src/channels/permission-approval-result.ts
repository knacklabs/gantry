import type { PermissionApprovalResult } from '../domain/types.js';

type DeliveryFailure = Extract<
  PermissionApprovalResult,
  { kind: 'delivery_failure' }
>;

export function deliveryNotSent(
  code: DeliveryFailure['code'],
  userMessage: string,
): DeliveryFailure {
  return {
    kind: 'delivery_failure',
    code,
    retryable: true,
    delivered: 'no',
    userMessage,
  };
}

export function deliveryUnknown(userMessage: string): DeliveryFailure {
  return {
    kind: 'delivery_failure',
    code: 'provider_failed',
    retryable: false,
    delivered: 'unknown',
    userMessage,
  };
}
