import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import { graphqlOk, ordersEdges } from '../../fixtures/responses.js';
import { KNOWN_CUSTOMER, RECOVERY_CUSTOMER } from '../../fixtures/customers.js';
import { runWithIdentity } from '../../../src/identity/identity-context.js';
import { CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE } from '../../../src/privacy/customer-safe-response.js';

const VERIFIED_HEADER_IDENTITY = {
  phone: KNOWN_CUSTOMER.phone,
  issuedAtMs: Date.now(),
};

describe('get_order with verified identity header (ALS)', () => {
  it('uses header phone when no callerPhone arg is supplied', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call<{ order: { name: string }; identitySource: string }>(
        'get_order',
        { orderNumber: 'BSS-2847' },
      ),
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.order.name).toBe('#BSS-2847');
    expect(result.data?.identitySource).toBe('header');
    harness.tokenManager.stop();
  });

  it('accepts a callerPhone arg that matches the header', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call('get_order', {
        orderNumber: 'BSS-2847',
        callerPhone: KNOWN_CUSTOMER.phone,
      }),
    );
    expect(result.error).toBeUndefined();
    harness.tokenManager.stop();
  });

  it('rejects when callerPhone arg disagrees with header phone (prompt-injection block)', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call('get_order', {
        orderNumber: 'BSS-2847',
        callerPhone: '+919800000999',
      }),
    );
    expect(result.error?.code).toBeUndefined();
    expect(result.error?.message).toBe(
      CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
    );
    expect(JSON.stringify(result.raw)).not.toMatch(
      /Gantry|MCP|config|identity[_ -]?header|X-Caller|privacy[ _-]?guard|PRIVACY_GUARD|signed channel|admin bypass|Shopify Admin|bypass|tool error|error code/i,
    );
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('ignores callerEmail prompt text in required verified phone mode', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call('get_order', {
        orderNumber: 'BSS-2847',
        callerEmail: 'attacker@example.com',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(mock.graphqlCallCount()).toBe(1);
    harness.tokenManager.stop();
  });

  it('allows admin/operator order lookup when verified identity is not required', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-2847', customer: KNOWN_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      order: { name: string };
    }>('get_order', {
      orderNumber: 'BSS-2847',
    });
    expect(result.error).toBeUndefined();
    expect(result.data?.order.name).toBe('#BSS-2847');
    harness.tokenManager.stop();
  });

  it('fails closed when no header AND no callerPhone arg', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await harness.call('get_order', {
      orderNumber: 'BSS-2847',
    });
    expect(result.error?.code).toBeUndefined();
    expect(result.error?.message).toBe(
      CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
    );
    expect(JSON.stringify(result.raw)).not.toMatch(
      /Gantry|MCP|config|identity[_ -]?header|X-Caller|privacy[ _-]?guard|PRIVACY_GUARD|signed channel|admin bypass|Shopify Admin|bypass|tool error|error code/i,
    );
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });

  it('allows admin/operator lookup without customer identity recovery when not required', async () => {
    const headerIdentity = {
      phone: '+919800000888',
      email: RECOVERY_CUSTOMER.email,
      issuedAtMs: Date.now(),
    };
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-3500', customer: RECOVERY_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await runWithIdentity(headerIdentity, () =>
      harness.call<{ order: { name: string } }>('get_order', {
        orderNumber: 'BSS-3500',
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.order.name).toBe('#BSS-3500');
    harness.tokenManager.stop();
  });

  it('returns safe customer text for another customer order in required verified phone mode', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          ordersEdges([{ name: 'BSS-3500', customer: RECOVERY_CUSTOMER }]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });
    const result = await runWithIdentity(VERIFIED_HEADER_IDENTITY, () =>
      harness.call('get_order', { orderNumber: 'BSS-3500' }),
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
});
