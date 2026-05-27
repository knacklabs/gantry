import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlErrors,
  graphqlOk,
  ordersEdges,
} from '../../fixtures/responses.js';
import { BUSY_CUSTOMER } from '../../fixtures/customers.js';
import { runWithIdentity } from '../../../src/identity/identity-context.js';
import { CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE } from '../../../src/privacy/customer-safe-response.js';

const VERIFIED_BUSY_CUSTOMER = {
  phone: BUSY_CUSTOMER.phone,
  issuedAtMs: Date.now(),
};

describe('list_orders_for_customer', () => {
  it('returns orders sorted by createdAt descending', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3001',
              customer: BUSY_CUSTOMER,
              createdAt: '2026-05-16T08:00:00Z',
            },
            {
              name: 'BSS-3002',
              customer: BUSY_CUSTOMER,
              createdAt: '2026-05-17T08:00:00Z',
            },
            {
              name: 'BSS-3003',
              customer: BUSY_CUSTOMER,
              createdAt: '2026-05-15T08:00:00Z',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call<{
        orders: Array<{ name: string; createdAt: string }>;
      }>('list_orders_for_customer', {
        customerId: BUSY_CUSTOMER.id,
        callerPhone: BUSY_CUSTOMER.phone,
        statusFilter: 'OPEN',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.orders.map((o) => o.name)).toEqual([
      '#BSS-3002',
      '#BSS-3001',
      '#BSS-3003',
    ]);
    harness.tokenManager.stop();
  });

  it('rejects when customerId does not belong to the verified caller', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(customersEdges([BUSY_CUSTOMER]))],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call('list_orders_for_customer', {
        customerId: 'gid://shopify/Customer/9999999',
        callerPhone: BUSY_CUSTOMER.phone,
        statusFilter: 'OPEN',
      }),
    );
    expect(result.error?.code).toBeUndefined();
    expect(result.error?.message).toBe(
      CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
    );
    expect(JSON.stringify(result.raw)).not.toMatch(
      /Gantry|MCP|config|identity[_ -]?header|X-Caller|privacy[ _-]?guard|PRIVACY_GUARD|signed channel|admin bypass|Shopify Admin|bypass|tool error|error code/i,
    );
    harness.tokenManager.stop();
  });

  it('rejects when no identity is supplied', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await harness.call('list_orders_for_customer', {
      customerId: BUSY_CUSTOMER.id,
    });
    expect(result.error?.code).toBeUndefined();
    expect(result.error?.message).toBe(
      CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
    );
    expect(JSON.stringify(result.raw)).not.toMatch(
      /Gantry|MCP|config|identity[_ -]?header|X-Caller|privacy[ _-]?guard|PRIVACY_GUARD|signed channel|admin bypass|Shopify Admin|bypass|tool error|error code/i,
    );
    harness.tokenManager.stop();
  });
});

describe('get_order_history', () => {
  it('returns orders in date range', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-1100',
              customer: BUSY_CUSTOMER,
              createdAt: '2025-10-15T08:00:00Z',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call<{
        orders: Array<{ name: string }>;
      }>('get_order_history', {
        customerId: BUSY_CUSTOMER.id,
        callerPhone: BUSY_CUSTOMER.phone,
        since: '2025-01-01T00:00:00Z',
        until: '2026-01-01T00:00:00Z',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.orders[0].name).toBe('#BSS-1100');
    harness.tokenManager.stop();
  });

  it('returns SCOPE_MISSING when GraphQL reports access denied for old orders', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlErrors([
          {
            message:
              'Access denied: read_all_orders scope required. Request access.',
          },
        ]),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call('get_order_history', {
        customerId: BUSY_CUSTOMER.id,
        callerPhone: BUSY_CUSTOMER.phone,
        since: '2024-01-01T00:00:00Z',
      }),
    );
    expect(result.error?.code).toBe('SCOPE_MISSING');
    harness.tokenManager.stop();
  });
});
