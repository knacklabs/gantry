import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import {
  customersEdges,
  graphqlOk,
  ordersEdges,
  productsEdges,
} from '../../fixtures/responses.js';
import { BUSY_CUSTOMER } from '../../fixtures/customers.js';
import { runWithIdentity } from '../../../src/identity/identity-context.js';
import { CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE } from '../../../src/privacy/customer-safe-response.js';

const VERIFIED_BUSY_CUSTOMER = {
  phone: BUSY_CUSTOMER.phone,
  issuedAtMs: Date.now(),
};

describe('get_gifting_context', () => {
  it('returns latest order and deduped compact product candidates in one aggregate call', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3002',
              customer: BUSY_CUSTOMER,
              createdAt: '2026-05-17T08:00:00Z',
              lineItems: [{ title: 'Choco Barks', quantity: 2 }],
              totalAmount: '2360.00',
              fulfillment: 'DELIVERED',
            },
          ]),
        ),
        graphqlOk(
          productsEdges([
            {
              id: 'gid://shopify/Product/snack-box',
              handle: 'snack-box',
              title: 'Snack Box',
              minPrice: '990.00',
              totalInventory: 20,
            },
            {
              id: 'gid://shopify/Product/care-package',
              handle: 'care-package',
              title: 'Care Package',
              minPrice: '1500.00',
              totalInventory: 10,
            },
          ]),
        ),
        graphqlOk(
          productsEdges([
            {
              id: 'gid://shopify/Product/snack-box',
              handle: 'snack-box',
              title: 'Snack Box',
              minPrice: '990.00',
              totalInventory: 20,
            },
            {
              id: 'gid://shopify/Product/chocolate-box',
              handle: 'chocolate-box',
              title: 'Chocolate Box',
              minPrice: '790.00',
              totalInventory: 0,
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
        latestOrder: {
          name: string;
          items: Array<{ title: string; quantity: number }>;
        } | null;
        products: Array<Record<string, unknown>>;
        productQueries: Array<{ query: string; resultCount: number }>;
      }>('get_gifting_context', {
        includeLatestOrder: true,
        productQueries: ['premium festive hamper', 'chocolate gift box'],
        maxProductsPerQuery: 3,
        budgetMax: 1200,
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.latestOrder?.name).toBe('#BSS-3002');
    expect(result.data?.latestOrder?.items).toEqual([
      { title: 'Choco Barks', quantity: 2 },
    ]);
    expect(result.data?.products.map((product) => product.handle)).toEqual([
      'snack-box',
      'chocolate-box',
    ]);
    expect(result.data?.products[0]).toEqual({
      id: 'gid://shopify/Product/snack-box',
      handle: 'snack-box',
      title: 'Snack Box',
      priceRange: {
        minVariantPrice: '990.00',
        maxVariantPrice: '990.00',
        currencyCode: 'INR',
      },
      available: true,
      matchedQueries: ['premium festive hamper', 'chocolate gift box'],
    });
    expect(result.data?.products[0]).not.toHaveProperty('description');
    expect(result.data?.products[0]).not.toHaveProperty('images');
    expect(result.data?.products).toHaveLength(2);
    expect(result.data?.productQueries).toEqual([
      { query: 'premium festive hamper', resultCount: 1 },
      { query: 'chocolate gift box', resultCount: 1 },
    ]);

    const graphqlBodies = mock.calls
      .filter((call) => call.url.includes('/graphql.json'))
      .map((call) => call.body as { variables?: Record<string, unknown> });
    expect(graphqlBodies[1]?.variables).toMatchObject({
      query: expect.stringContaining('customer_id:1003'),
      first: 1,
    });
    expect(graphqlBodies[2]?.variables).toMatchObject({
      query: expect.stringContaining('premium festive hamper'),
      first: 3,
    });
    expect(graphqlBodies[3]?.variables).toMatchObject({
      query: expect.stringContaining('chocolate gift box'),
      first: 3,
    });
    harness.tokenManager.stop();
  });

  it('returns structured source data for qualified gifting briefs', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3002',
              customer: BUSY_CUSTOMER,
              createdAt: '2026-05-17T08:00:00Z',
              lineItems: [{ title: 'Choco Barks', quantity: 2 }],
              totalAmount: '2360.00',
              fulfillment: 'DELIVERED',
            },
          ]),
        ),
        graphqlOk(
          productsEdges([
            {
              id: 'gid://shopify/Product/snack-box',
              handle: 'snack-box',
              title: 'Snack Box',
              minPrice: '990.00',
              totalInventory: 20,
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
        latestOrder: {
          name: string;
          items: Array<{ title: string; quantity: number }>;
        } | null;
        products: Array<{ handle: string; matchedQueries: string[] }>;
        productQueries: Array<{ query: string; resultCount: number }>;
      }>('get_gifting_context', {
        includeLatestOrder: true,
        productQueries: ['premium festive hamper'],
        maxProductsPerQuery: 3,
        occasion: 'Diwali',
        quantity: 80,
        budgetMax: 1200,
        delivery_locations: ['Mumbai', 'Delhi'],
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.latestOrder?.name).toBe('#BSS-3002');
    expect(result.data?.latestOrder?.items).toEqual([
      { title: 'Choco Barks', quantity: 2 },
    ]);
    expect(result.data?.products).toMatchObject([
      {
        handle: 'snack-box',
        matchedQueries: ['premium festive hamper'],
      },
    ]);
    expect(result.data?.productQueries).toEqual([
      { query: 'premium festive hamper', resultCount: 1 },
    ]);
    harness.tokenManager.stop();
  });

  it('treats false optional brief fields as missing instead of failing validation', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(ordersEdges([])),
        graphqlOk(productsEdges([])),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });

    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call<{
        latestOrder: unknown;
        products: unknown[];
        productQueries: Array<{ query: string; resultCount: number }>;
      }>('get_gifting_context', {
        includeLatestOrder: true,
        occasion: 'Diwali',
        quantity: 80,
        budgetMax: 1200,
        delivery_locations: ['Mumbai', 'Delhi'],
        branding: false,
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({
      latestOrder: null,
      products: [],
      productQueries: [],
      matchedVia: 'phone',
      identitySource: 'header',
    });
    harness.tokenManager.stop();
  });

  it('returns empty product query metadata when searches find nothing', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(ordersEdges([])),
        graphqlOk(productsEdges([])),
      ],
    });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });

    const result = await runWithIdentity(VERIFIED_BUSY_CUSTOMER, () =>
      harness.call<{
        latestOrder: unknown;
        products: unknown[];
        productQueries: Array<{ query: string; resultCount: number }>;
      }>('get_gifting_context', {
        includeLatestOrder: true,
        productQueries: ['diwali hamper'],
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({
      latestOrder: null,
      products: [],
      productQueries: [{ query: 'diwali hamper', resultCount: 0 }],
      matchedVia: 'phone',
      identitySource: 'header',
    });
    harness.tokenManager.stop();
  });

  it('uses a default gifting query and limit alias when the model omits productQueries', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(ordersEdges([])),
        graphqlOk(
          productsEdges([
            {
              handle: 'snack-box',
              title: 'Snack Box',
              minPrice: '990.00',
            },
            {
              handle: 'deluxe-box',
              title: 'Deluxe Box',
              minPrice: '1500.00',
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
        products: Array<{ handle: string }>;
        productQueries: Array<{ query: string; resultCount: number }>;
      }>('get_gifting_context', {
        includeLatestOrder: true,
        limit: 1,
        budget: 1200,
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((product) => product.handle)).toEqual([
      'snack-box',
    ]);
    expect(result.data?.productQueries).toEqual([
      { query: 'premium festive hamper gift box', resultCount: 1 },
    ]);
    const productCall = mock.calls
      .filter((call) => call.url.includes('/graphql.json'))
      .find((call) => {
        const variables = (call.body as { variables?: { query?: string } })
          .variables;
        return variables?.query?.includes('premium festive hamper gift box');
      });
    expect(productCall).toBeDefined();
    expect(
      (productCall!.body as { variables: { query: string } }).variables.query,
    ).toContain('variants.price:<=1200');
    expect(
      (productCall!.body as { variables: { first: number } }).variables.first,
    ).toBe(1);
    harness.tokenManager.stop();
  });

  it('skips speculative default product search for strong B2B gifting briefs', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(customersEdges([BUSY_CUSTOMER])),
        graphqlOk(
          ordersEdges([
            {
              name: 'BSS-3002',
              customer: BUSY_CUSTOMER,
              createdAt: '2026-05-17T08:00:00Z',
              lineItems: [{ title: 'Choco Barks', quantity: 2 }],
              totalAmount: '2360.00',
              fulfillment: 'DELIVERED',
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
        latestOrder: { name: string } | null;
        products: Array<{ handle: string }>;
        productQueries: Array<{ query: string; resultCount: number }>;
      }>('get_gifting_context', {
        includeLatestOrder: true,
        occasion: 'Diwali',
        quantity: 80,
        budgetMax: 1200,
        delivery_locations: ['Mumbai', 'Delhi'],
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.latestOrder?.name).toBe('#BSS-3002');
    expect(result.data?.products).toEqual([]);
    expect(result.data?.productQueries).toEqual([]);
    expect(mock.graphqlCallCount()).toBe(2);
    harness.tokenManager.stop();
  });

  it('keeps required-identity privacy denials customer-safe', async () => {
    const mock = buildMockFetch({ graphqlResponses: [] });
    const harness = buildToolHarness(mock.fetch, {
      requireVerifiedIdentity: true,
    });

    const result = await harness.call('get_gifting_context', {
      includeLatestOrder: true,
      productQueries: ['diwali hamper'],
    });

    expect(result.error?.message).toBe(
      CUSTOMER_VERIFIED_PHONE_NOT_FOUND_MESSAGE,
    );
    expect(JSON.stringify(result.raw)).not.toMatch(
      /Gantry|MCP|config|identity[_ -]?header|X-Caller|privacy[ _-]?guard|PRIVACY_GUARD|signed channel|admin bypass|Shopify Admin|bypass|tool error|error code/i,
    );
    expect(mock.graphqlCallCount()).toBe(0);
    harness.tokenManager.stop();
  });
});
