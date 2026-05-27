import { ShopifyAdapterError } from '../errors.js';
import {
  FIND_CUSTOMER_BY_EMAIL,
  FIND_CUSTOMER_BY_PHONE,
} from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import type { ShopifyCustomer } from '../shopify/types.js';
import { normalizeEmail, normalizePhone } from './guard.js';
import type { EffectiveIdentity } from './effective-identity.js';
import type { CustomerIdentityCache } from './customer-identity-cache.js';
import { customerVerifiedPhoneNotFoundError } from './customer-safe-response.js';

interface CustomerEdgesResponse {
  customers: { edges: Array<{ node: ShopifyCustomer }> };
}

function customerIdMismatchError(
  identity: EffectiveIdentity,
  fallbackMessage: string,
  dev: string,
): ShopifyAdapterError {
  if (identity.requireVerifiedIdentity) {
    return customerVerifiedPhoneNotFoundError('CUSTOMER_ID_MISMATCH', dev);
  }
  return new ShopifyAdapterError('PRIVACY_GUARD_FAILED', fallbackMessage, {
    reason: 'CUSTOMER_ID_MISMATCH',
    dev,
  });
}

/**
 * Resolves the verified caller to a Shopify customer record and asserts the
 * customerId the caller is asking about matches that record. Throws
 * PRIVACY_GUARD_FAILED if it doesn't.
 *
 * This is the privacy boundary for tools that take a `customerId` directly
 * (list_orders_for_customer, get_order_history). Without it, a prompt-injected
 * agent could list orders for any customerId it knows or guesses.
 *
 * If a {@link CustomerIdentityCache} is supplied, successful resolutions are
 * cached so subsequent calls for the same verified identity skip the lookup.
 */
export async function assertCustomerBelongsToCaller(
  client: ShopifyClient,
  identity: EffectiveIdentity,
  rawCustomerId: string,
  cache?: CustomerIdentityCache,
): Promise<{ resolvedId: string; matchedVia: 'phone' | 'email' }> {
  const wanted = normalizeShopifyCustomerId(rawCustomerId);

  // Cache fast path — skip Shopify if we've recently resolved this identity.
  if (cache) {
    const hit = cache.get({ phone: identity.phone, email: identity.email });
    if (hit) {
      if (normalizeShopifyCustomerId(hit.customerId) === wanted) {
        return { resolvedId: hit.customerId, matchedVia: hit.matchedVia };
      }
      throw customerIdMismatchError(
        identity,
        'You can only check details linked to your own phone number.',
        'customerId does not belong to the verified caller (cached identity)',
      );
    }
  }

  if (identity.phone) {
    const phone = normalizePhone(identity.phone);
    if (phone) {
      const data = await client.graphql<CustomerEdgesResponse>(
        FIND_CUSTOMER_BY_PHONE,
        { query: `phone:${phone}` },
      );
      const match = (data.customers?.edges ?? []).find(
        (edge) => normalizePhone(edge.node.phone) === phone,
      );
      if (match) {
        cache?.set(
          { phone: identity.phone, email: identity.email },
          match.node.id,
          'phone',
        );
        if (normalizeShopifyCustomerId(match.node.id) === wanted) {
          return { resolvedId: match.node.id, matchedVia: 'phone' };
        }
        throw customerIdMismatchError(
          identity,
          'You can only check details linked to your own phone number.',
          'customerId does not belong to the verified caller (phone path)',
        );
      }
    }
  }

  if (identity.email) {
    const email = normalizeEmail(identity.email);
    if (email) {
      const data = await client.graphql<CustomerEdgesResponse>(
        FIND_CUSTOMER_BY_EMAIL,
        { query: `email:${email}` },
      );
      const match = (data.customers?.edges ?? []).find(
        (edge) => normalizeEmail(edge.node.email) === email,
      );
      if (match) {
        cache?.set(
          { phone: identity.phone, email: identity.email },
          match.node.id,
          'email',
        );
        if (normalizeShopifyCustomerId(match.node.id) === wanted) {
          return { resolvedId: match.node.id, matchedVia: 'email' };
        }
        throw customerIdMismatchError(
          identity,
          'You can only check details linked to your own account.',
          'customerId does not belong to the verified caller (email path)',
        );
      }
    }
  }

  if (identity.requireVerifiedIdentity) {
    throw customerVerifiedPhoneNotFoundError(
      'CALLER_NOT_FOUND',
      'verified caller does not correspond to any known customer',
    );
  }
  throw new ShopifyAdapterError(
    'PRIVACY_GUARD_FAILED',
    "I couldn't find any account linked to your phone number. Please make sure you're messaging from the number you used when placing the order.",
    {
      reason: 'CALLER_NOT_FOUND',
      dev: 'verified caller does not correspond to any known customer',
    },
  );
}

const GID_PREFIX = 'gid://shopify/Customer/';

export function normalizeShopifyCustomerId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(GID_PREFIX)) {
    const numeric = trimmed.slice(GID_PREFIX.length).split('?')[0];
    return numeric;
  }
  return trimmed;
}
