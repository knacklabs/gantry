import { ShopifyAdapterError } from '../errors.js';

export const CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE =
  'I can only check details linked to the phone number you are messaging from. The phone number, email, or order you asked about does not match that number.';

export type CustomerIdentityFailureReason =
  | 'VERIFIED_PHONE_UNAVAILABLE'
  | 'ARG_VS_HEADER_MISMATCH'
  | 'CALLER_NOT_FOUND'
  | 'CUSTOMER_ID_MISMATCH'
  | 'ORDER_CUSTOMER_MISMATCH';

export function customerVerifiedPhoneNotFoundError(
  reason: CustomerIdentityFailureReason,
  dev: string,
): ShopifyAdapterError {
  return new ShopifyAdapterError(
    'PRIVACY_GUARD_FAILED',
    CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
    { reason, dev, customerSafe: true },
  );
}
