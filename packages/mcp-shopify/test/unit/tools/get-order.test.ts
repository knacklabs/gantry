import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../../fixtures/responses.js';
import { KNOWN_CUSTOMER, RECOVERY_CUSTOMER } from '../../fixtures/customers.js';

describe('get_order', () => {
  it('returns order when phone matches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ order: { name: string } }>(
      'get_order',
      { orderNumber: 'BSS-2847', callerPhone: KNOWN_CUSTOMER.phone },
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.order.name).toBe('#BSS-2847');
    harness.tokenManager.stop();
  });

  it('privacy-blocks a mismatched caller phone', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call('get_order', {
      orderNumber: 'BSS-2847',
      callerPhone: '+919999999999',
    });
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect(result.error?.message).toBe(
      'You can only check details linked to your own account.',
    );
    expect((result.raw as { order?: unknown }).order).toBeUndefined();
    harness.tokenManager.stop();
  });

  it('accepts email recovery path when phone mismatches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: RECOVERY_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      order: { name: string; customerId: string };
    }>('get_order', {
      orderNumber: 'BSS-2847',
      callerPhone: '+919999999999',
      callerEmail: RECOVERY_CUSTOMER.email,
    });
    expect(result.error).toBeUndefined();
    expect(result.data?.order.name).toBe('#BSS-2847');
    expect(result.data?.order.customerId).toBe(RECOVERY_CUSTOMER.id);
    harness.tokenManager.stop();
  });

  it('emits NOT_FOUND when order does not exist', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk({ orders: { edges: [] } })],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call('get_order', {
      orderNumber: 'BSS-9999',
      callerPhone: KNOWN_CUSTOMER.phone,
    });
    expect(result.error?.code).toBe('NOT_FOUND');
    harness.tokenManager.stop();
  });
});
