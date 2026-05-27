import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlOk,
  ordersEdges,
} from '../../fixtures/responses.js';
import { KNOWN_CUSTOMER } from '../../fixtures/customers.js';
import { CustomerIdentityCache } from '../../../src/privacy/customer-identity-cache.js';
import { runWithIdentity } from '../../../src/identity/identity-context.js';
import { CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE } from '../../../src/privacy/customer-safe-response.js';

const VERIFIED_KNOWN_CUSTOMER = {
  phone: KNOWN_CUSTOMER.phone,
  issuedAtMs: Date.now(),
};

describe('CustomerIdentityCache cross-call behavior', () => {
  it('second list_orders_for_customer call hits the cache and skips the identity lookup', async () => {
    // Mock 3 GraphQL responses:
    //   1) ownership lookup (FIND_CUSTOMER_BY_PHONE) — first call only
    //   2) orders list — first call
    //   3) orders list — second call (no preceding lookup because cached)
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3001',
              customer: KNOWN_CUSTOMER,
              createdAt: '2026-05-17T10:00:00Z',
            },
          ]),
        ),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3001',
              customer: KNOWN_CUSTOMER,
              createdAt: '2026-05-17T10:00:00Z',
            },
          ]),
        ),
      ],
    });
    const cache = new CustomerIdentityCache({ ttlMs: 60_000 });
    const harness = buildToolHarness(mock.fetch, {
      identityCache: cache,
      requireVerifiedIdentity: true,
    });

    const first = await runWithIdentity(VERIFIED_KNOWN_CUSTOMER, () =>
      harness.call('list_orders_for_customer', {
        customerId: KNOWN_CUSTOMER.id,
        callerPhone: KNOWN_CUSTOMER.phone,
      }),
    );
    expect(first.error).toBeUndefined();

    const callsAfterFirst = mock.graphqlCallCount();

    const second = await runWithIdentity(VERIFIED_KNOWN_CUSTOMER, () =>
      harness.call('list_orders_for_customer', {
        customerId: KNOWN_CUSTOMER.id,
        callerPhone: KNOWN_CUSTOMER.phone,
      }),
    );
    expect(second.error).toBeUndefined();

    // First call did 2 GraphQL hits (identity + list). Second call should
    // skip the identity lookup and do only 1 (the list).
    expect(callsAfterFirst).toBe(2);
    expect(mock.graphqlCallCount() - callsAfterFirst).toBe(1);
    expect(cache.size()).toBe(1);
    harness.tokenManager.stop();
  });

  it('cached entry rejects a customerId that does not belong to the verified caller', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        graphqlOk(ordersEdges([{ name: 'BSS-1', customer: KNOWN_CUSTOMER }])),
      ],
    });
    const cache = new CustomerIdentityCache({ ttlMs: 60_000 });
    const harness = buildToolHarness(mock.fetch, {
      identityCache: cache,
      requireVerifiedIdentity: true,
    });

    // First call populates cache with KNOWN_CUSTOMER.id
    await runWithIdentity(VERIFIED_KNOWN_CUSTOMER, () =>
      harness.call('list_orders_for_customer', {
        customerId: KNOWN_CUSTOMER.id,
        callerPhone: KNOWN_CUSTOMER.phone,
      }),
    );
    const callsAfterFirst = mock.graphqlCallCount();

    // Second call asks for a DIFFERENT customerId with the same caller phone.
    // Cache says "this phone resolves to KNOWN_CUSTOMER.id, not the one
    // you're asking about" → reject immediately, no Shopify call.
    const second = await runWithIdentity(VERIFIED_KNOWN_CUSTOMER, () =>
      harness.call('list_orders_for_customer', {
        customerId: 'gid://shopify/Customer/9999999',
        callerPhone: KNOWN_CUSTOMER.phone,
      }),
    );
    expect(second.error?.code).toBeUndefined();
    expect(second.error?.message).toBe(
      CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
    );
    expect(JSON.stringify(second.raw)).not.toMatch(
      /Gantry|MCP|config|identity[_ -]?header|X-Caller|privacy[ _-]?guard|PRIVACY_GUARD|signed channel|admin bypass|Shopify Admin|bypass|tool error|error code/i,
    );
    expect(mock.graphqlCallCount()).toBe(callsAfterFirst);
    harness.tokenManager.stop();
  });

  it('without a cache, every call re-does the identity lookup', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        graphqlOk(ordersEdges([{ name: 'BSS-1', customer: KNOWN_CUSTOMER }])),
        graphqlOk(customersEdges([KNOWN_CUSTOMER])),
        graphqlOk(ordersEdges([{ name: 'BSS-1', customer: KNOWN_CUSTOMER }])),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    }); // no cache

    await runWithIdentity(VERIFIED_KNOWN_CUSTOMER, () =>
      harness.call('list_orders_for_customer', {
        customerId: KNOWN_CUSTOMER.id,
        callerPhone: KNOWN_CUSTOMER.phone,
      }),
    );
    await runWithIdentity(VERIFIED_KNOWN_CUSTOMER, () =>
      harness.call('list_orders_for_customer', {
        customerId: KNOWN_CUSTOMER.id,
        callerPhone: KNOWN_CUSTOMER.phone,
      }),
    );
    // 4 calls total: 2 lookups + 2 list queries
    expect(mock.graphqlCallCount()).toBe(4);
    harness.tokenManager.stop();
  });
});
