import { describe, expect, it } from 'vitest';
import { buildToolHarness } from '../../helpers/tool-harness.js';
import { buildMockFetch } from '../../helpers/mock-fetch.js';
import {
  discountNodes,
  emptyProductByHandle,
  graphqlOk,
  productByHandle,
  productInventoryByHandle,
  productsEdges,
  variantInventory,
} from '../../fixtures/responses.js';
import { ProductSearchCache } from '../../../src/tools/product-search-cache.js';

describe('search_products', () => {
  it('returns products filtered by tag and active status', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'diwali-gift-hamper',
              title: 'Diwali Gift Hamper',
              tags: ['diwali', 'gift'],
              totalInventory: 12,
              minPrice: '1499.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<{ handle: string; available: boolean }>;
    }>('search_products', { tag: 'diwali' });
    expect(result.error).toBeUndefined();
    expect(result.data?.products[0].handle).toBe('diwali-gift-hamper');
    expect(result.data?.products[0].available).toBe(true);
    harness.tokenManager.stop();
  });

  it('returns compact search summaries without bulky product fields', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'kaju-katli',
              title: 'Kaju Katli Box',
              description:
                'A long product story that belongs on detail lookup.',
              tags: ['show-search', 'active', 'contains-nuts'],
              totalInventory: 12,
              minPrice: '515.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<Record<string, unknown>>;
    }>('search_products', { query: 'all sweets' });

    expect(result.error).toBeUndefined();
    expect(result.raw).not.toHaveProperty('customerReplyDraft');
    expect(result.raw).not.toHaveProperty('replyContract');
    expect(result.data?.products[0]).toEqual({
      id: 'gid://shopify/Product/kaju-katli',
      handle: 'kaju-katli',
      title: 'Kaju Katli Box',
      priceRange: {
        minVariantPrice: '515.00',
        maxVariantPrice: '515.00',
        currencyCode: 'INR',
      },
      available: true,
    });
    expect(result.data?.products[0]).not.toHaveProperty('description');
    expect(result.data?.products[0]).not.toHaveProperty('tags');
    expect(result.data?.products[0]).not.toHaveProperty('images');
    expect(result.data?.products[0]).not.toHaveProperty('onlineStoreUrl');
    harness.tokenManager.stop();
  });

  it('directs product-detail questions to get_product instead of repeated search', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'kaju-katli',
              title: 'Kaju Katli Box',
              description:
                'A long product story that belongs on detail lookup.',
              tags: ['show-search', 'active', 'contains-nuts'],
              totalInventory: 12,
              minPrice: '515.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      replyContract?: {
        status: string;
        useCustomerReplyDraft: boolean;
        mustCallGetProductBeforeAnswer: boolean;
        mustNotSearchAgain: boolean;
      };
      nextTool?: {
        name: string;
        arguments: { id: string };
        reason: string;
      };
      products: Array<{ id: string; handle: string }>;
    }>('search_products', { query: 'Kaju Katli box pieces' });

    expect(result.error).toBeUndefined();
    expect(result.data?.replyContract).toEqual({
      status: 'success',
      useCustomerReplyDraft: false,
      mustCallGetProductBeforeAnswer: true,
      mustNotSearchAgain: true,
    });
    expect(result.data?.nextTool).toEqual({
      name: 'get_product',
      arguments: { id: 'gid://shopify/Product/kaju-katli' },
      reason: expect.stringContaining('get_product is required'),
    });
    expect(result.data?.products[0]).toMatchObject({
      id: 'gid://shopify/Product/kaju-katli',
      handle: 'kaju-katli',
    });
    harness.tokenManager.stop();
  });

  it('filters results by priceMin / priceMax post-fetch', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'cheap-box',
              title: 'Cheap',
              minPrice: '300.00',
              maxPrice: '300.00',
            },
            {
              handle: 'in-band',
              title: 'In band',
              minPrice: '600.00',
              maxPrice: '700.00',
            },
            {
              handle: 'too-expensive',
              title: 'Too expensive',
              minPrice: '900.00',
              maxPrice: '900.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', { priceMin: 500, priceMax: 800 });
    expect(result.data?.products.map((p) => p.handle)).toEqual(['in-band']);
    harness.tokenManager.stop();
  });

  it('defaults to a compact 3-product fetch and accepts maxPrice alias', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'under-budget',
              title: 'Under budget',
              minPrice: '350.00',
              maxPrice: '350.00',
            },
            {
              handle: 'over-budget',
              title: 'Over budget',
              minPrice: '900.00',
              maxPrice: '900.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', { query: 'birthday gift', maxPrice: 500 });

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((p) => p.handle)).toEqual([
      'under-budget',
    ]);
    const productCall = mock.calls.find((call) =>
      call.url.includes('/graphql.json'),
    );
    expect(
      (productCall!.body as { variables: { first: number; query: string } })
        .variables,
    ).toMatchObject({
      first: 3,
      query: expect.stringContaining('variants.price:<=500'),
    });
    harness.tokenManager.stop();
  });

  it('returns website-first reply facts for personal gifting product searches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'three-layer-fudge',
              title: "Bombay's 3-Layer Chocolate Fudge",
              minPrice: '350.00',
              maxPrice: '350.00',
            },
            {
              handle: 'playing-cards',
              title: 'Bombay Sweet Shop Playing Cards',
              minPrice: '400.00',
              maxPrice: '400.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      replyContract?: {
        status: string;
        mustLeadWithWebsiteOrdering: boolean;
        mustNotGuaranteeLiveStock: boolean;
        mustSuggestAtMostThreeProducts: boolean;
        mustPresentProductsAsAlternatives: boolean;
      };
      replyFacts?: {
        recommendation: {
          route: string;
          websiteFirst: boolean;
          presentation: string;
          maxSuggestions: number;
          budgetMax?: number;
        };
      };
      products: Array<{ title: string }>;
    }>('search_products', { query: 'birthday gift', priceMax: 500 });

    expect(result.error).toBeUndefined();
    expect(result.raw).not.toHaveProperty('customerReplyDraft');
    expect(result.data?.replyContract).toMatchObject({
      status: 'success',
      mustLeadWithWebsiteOrdering: true,
      mustNotGuaranteeLiveStock: true,
      mustSuggestAtMostThreeProducts: true,
      mustPresentProductsAsAlternatives: true,
    });
    expect(result.data?.replyFacts).toEqual({
      recommendation: {
        route: 'personal_gifting',
        websiteFirst: true,
        presentation: 'alternatives',
        maxSuggestions: 3,
        budgetMax: 500,
      },
    });
    expect(JSON.stringify(result.raw)).not.toMatch(/under your budget/i);
    expect(JSON.stringify(result.raw)).not.toMatch(/available right now/i);
    harness.tokenManager.stop();
  });

  it('caps personal gifting responses to three non-accessory products', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'saffron',
              title: 'Saffron in Glass Bottle',
              minPrice: '500.00',
              maxPrice: '500.00',
            },
            {
              handle: 'fudge',
              title: "Bombay's 3-Layer Chocolate Fudge",
              minPrice: '350.00',
              maxPrice: '350.00',
            },
            {
              handle: 'gift-bag',
              title: 'Small Coral Gift Bag',
              minPrice: '75.00',
              maxPrice: '75.00',
            },
            {
              handle: 'over-budget-snack-box',
              title: 'Bombay Sweet Shop Snack Box',
              minPrice: '990.00',
              maxPrice: '990.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', {
      query: 'gifting roka mithai box celebration',
      priceMax: 900,
      limit: 5,
    });

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((p) => p.handle)).toEqual([
      'saffron',
      'fudge',
    ]);
    expect(result.raw).not.toHaveProperty('customerReplyDraft');
    expect(JSON.stringify(result.raw)).not.toMatch(/birthday/i);
    expect(JSON.stringify(result.raw)).not.toContain('Small Coral Gift Bag');
    expect(JSON.stringify(result.raw)).not.toContain(
      'Bombay Sweet Shop Snack Box',
    );
    harness.tokenManager.stop();
  });

  it('does not attach personal gifting reply facts for bulk or event gifting searches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'wedding-hamper',
              title: 'Wedding Hamper',
              minPrice: '900.00',
              maxPrice: '900.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', { query: 'gift hamper wedding', limit: 3 });

    expect(result.error).toBeUndefined();
    expect(result.raw).not.toHaveProperty('customerReplyDraft');
    expect(result.raw).not.toHaveProperty('replyContract');
    expect(result.data?.products.map((p) => p.handle)).toEqual([
      'wedding-hamper',
    ]);
    harness.tokenManager.stop();
  });

  it('does not run broad gift-box fallback for bulk or event gifting searches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(productsEdges([]))],
    });
    const harness = buildToolHarness(mock.fetch);

    const result = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', {
      query: 'corporate gift box with logo',
      limit: 3,
    });

    expect(result.error).toBeUndefined();
    expect(result.data?.products).toEqual([]);
    expect(mock.graphqlCallCount()).toBe(1);
    const graphqlQuery = (
      mock.calls.find((call) => call.url.includes('/graphql.json'))!.body as {
        variables: { query: string };
      }
    ).variables.query;
    expect(graphqlQuery).toContain('corporate gift box with logo');
    harness.tokenManager.stop();
  });

  it('caches product search results by normalized query and limit', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'cached-gift',
              title: 'Cached Gift',
              minPrice: '500.00',
              maxPrice: '500.00',
            },
          ]),
        ),
      ],
    });
    const cache = new ProductSearchCache({
      ttlMs: 86_400_000,
      refreshLeadMs: 600_000,
    });
    const harness = buildToolHarness(mock.fetch, { productSearchCache: cache });

    await harness.call('search_products', { query: 'gift', maxPrice: 500 });
    const result = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', { query: 'gift', priceMax: 500 });

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((p) => p.handle)).toEqual(['cached-gift']);
    expect(mock.graphqlCallCount()).toBe(1);
    harness.tokenManager.stop();
  });

  it('returns cached search results while refreshing near expiry', async () => {
    let now = 1_000;
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productsEdges([
            {
              handle: 'old-gift',
              title: 'Old Gift',
              minPrice: '450.00',
              maxPrice: '450.00',
            },
          ]),
        ),
        graphqlOk(
          productsEdges([
            {
              handle: 'fresh-gift',
              title: 'Fresh Gift',
              minPrice: '450.00',
              maxPrice: '450.00',
            },
          ]),
        ),
      ],
    });
    const cache = new ProductSearchCache({
      ttlMs: 86_400_000,
      refreshLeadMs: 600_000,
      now: () => now,
    });
    const harness = buildToolHarness(mock.fetch, { productSearchCache: cache });

    await harness.call('search_products', { query: 'gift', priceMax: 500 });
    now = 86_400_000 - 600_000 + 1_000;
    const staleWhileRefresh = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', { query: 'gift', priceMax: 500 });

    expect(staleWhileRefresh.data?.products.map((p) => p.handle)).toEqual([
      'old-gift',
    ]);
    await cache.waitForIdle();
    expect(mock.graphqlCallCount()).toBe(2);

    const refreshed = await harness.call<{
      products: Array<{ handle: string }>;
    }>('search_products', { query: 'gift', priceMax: 500 });
    expect(refreshed.data?.products.map((p) => p.handle)).toEqual([
      'fresh-gift',
    ]);
    harness.tokenManager.stop();
  });

  it('returns customer-safe no-match facts for empty search results', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(productsEdges([]))],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      replyContract?: {
        status: string;
        mustNotUseHiccupWording: boolean;
        emptyProductResult: boolean;
      };
      replyFacts?: {
        emptyResult: {
          target: string;
        };
      };
      products: Array<Record<string, unknown>>;
    }>('search_products', { query: 'durian cheesecake' });

    expect(result.error).toBeUndefined();
    expect(
      Object.keys(result.raw as Record<string, unknown>).slice(0, 2),
    ).toEqual(['replyContract', 'replyFacts']);
    expect(result.raw).not.toHaveProperty('customerReplyDraft');
    expect(result.data?.products).toEqual([]);
    expect(result.data?.replyContract).toEqual({
      status: 'success',
      mustNotUseHiccupWording: true,
      emptyProductResult: true,
    });
    expect(result.data?.replyFacts).toEqual({
      emptyResult: {
        target: 'durian cheesecake',
      },
    });
    expect(JSON.stringify(result.raw)).not.toContain("I couldn't find");
    expect(JSON.stringify(result.raw)).not.toMatch(/checking/i);
    harness.tokenManager.stop();
  });

  it('falls back inside one tool call for common birthday gift wording', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(productsEdges([])),
        graphqlOk(
          productsEdges([
            {
              handle: 'three-layer-fudge',
              title: "Bombay's 3-Layer Chocolate Fudge",
              minPrice: '350.00',
              maxPrice: '350.00',
            },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      products: Array<{ handle: string }>;
      matchedQuery?: string;
    }>('search_products', { query: 'gift birthday', priceMax: 500 });

    expect(result.error).toBeUndefined();
    expect(result.data?.products.map((p) => p.handle)).toEqual([
      'three-layer-fudge',
    ]);
    expect(result.data?.matchedQuery).toBe('gift box');
    const graphqlCalls = mock.calls.filter((call) =>
      call.url.includes('/graphql.json'),
    );
    expect(graphqlCalls).toHaveLength(2);
    harness.tokenManager.stop();
  });
});

describe('get_product', () => {
  it('returns product when handle matches', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productByHandle({
            handle: 'kaju-katli',
            title: 'Kaju Katli Box',
            totalInventory: 50,
          }),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      product: { handle: string; available: boolean } | null;
    }>('get_product', { handleOrId: 'kaju-katli' });
    expect(result.data?.product?.handle).toBe('kaju-katli');
    expect(result.data?.product?.available).toBe(true);
    harness.tokenManager.stop();
  });

  it('accepts handle as a compatibility alias for handleOrId', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productByHandle({
            handle: 'chocolate-butterscotch-bark',
            title: 'Choco Butterscotch Barks (200g)',
          }),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      product: { handle: string; available: boolean } | null;
    }>('get_product', { handle: 'chocolate-butterscotch-bark' });
    expect(result.error).toBeUndefined();
    expect(result.data?.product?.handle).toBe('chocolate-butterscotch-bark');
    harness.tokenManager.stop();
  });

  it('accepts id as a compatibility alias for handleOrId', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk({
          product: productByHandle({
            id: 'gid://shopify/Product/8420946313465',
            handle: 'best-kaju-katli-chocolate-barfi',
            title: 'Indie Bites - 54.5% Dark Chocolate Kaju Katli',
          }).productByHandle,
        }),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      product: { handle: string; available: boolean } | null;
    }>('get_product', { id: 'gid://shopify/Product/8420946313465' });
    expect(result.error).toBeUndefined();
    expect(result.data?.product?.handle).toBe(
      'best-kaju-katli-chocolate-barfi',
    );
    harness.tokenManager.stop();
  });

  it('returns null when handle does not exist', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(emptyProductByHandle())],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ product: unknown }>('get_product', {
      handleOrId: 'unknown-handle',
    });
    expect(result.data?.product).toBeNull();
    harness.tokenManager.stop();
  });
});

describe('check_inventory', () => {
  it('returns sufficient=true when stock exceeds requested', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(variantInventory(50))],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      totalQuantity: number;
      sufficient?: boolean;
    }>('check_inventory', {
      variantId: 'gid://shopify/ProductVariant/9999',
      requestedQuantity: 20,
    });
    expect(result.data?.totalQuantity).toBe(50);
    expect(result.data?.sufficient).toBe(true);
    harness.tokenManager.stop();
  });

  it('returns sufficient=false when stock below requested', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          productInventoryByHandle(
            { handle: 'low-stock', title: 'Low Stock' },
            [
              { id: 'gid://shopify/ProductVariant/1', inventoryQuantity: 3 },
              { id: 'gid://shopify/ProductVariant/2', inventoryQuantity: 2 },
            ],
          ),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      sufficient?: boolean;
      totalQuantity: number;
    }>('check_inventory', {
      productHandle: 'low-stock',
      requestedQuantity: 20,
    });
    expect(result.data?.totalQuantity).toBe(5);
    expect(result.data?.sufficient).toBe(false);
    harness.tokenManager.stop();
  });
});

describe('validate_discount_code', () => {
  it('returns active+meetsMinimum=true', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(
          discountNodes([
            { title: 'BSSDIWALI20', minimumOrderAmount: '1000.00' },
          ]),
        ),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      exists: boolean;
      active: boolean;
      minimumOrderAmount?: number;
      meetsMinimum?: boolean;
    }>('validate_discount_code', { code: 'BSSDIWALI20', cartTotal: 1200 });
    expect(result.data?.exists).toBe(true);
    expect(result.data?.active).toBe(true);
    expect(result.data?.minimumOrderAmount).toBe(1000);
    expect(result.data?.meetsMinimum).toBe(true);
    harness.tokenManager.stop();
  });

  it('returns meetsMinimum=true when cartTotal is passed and discount has no minimum', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk(discountNodes([{ title: 'NOMIN' }]))],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      exists: boolean;
      active: boolean;
      meetsMinimum?: boolean;
      minimumOrderAmount?: number;
    }>('validate_discount_code', { code: 'NOMIN', cartTotal: 99 });
    expect(result.data?.exists).toBe(true);
    expect(result.data?.active).toBe(true);
    expect(result.data?.meetsMinimum).toBe(true);
    expect(result.data?.minimumOrderAmount).toBeUndefined();
    harness.tokenManager.stop();
  });

  it('returns active=false with reason for expired code', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [
        graphqlOk(discountNodes([{ title: 'OLDCODE', status: 'EXPIRED' }])),
      ],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{
      exists: boolean;
      active: boolean;
      reason?: string;
    }>('validate_discount_code', { code: 'OLDCODE' });
    expect(result.data?.exists).toBe(true);
    expect(result.data?.active).toBe(false);
    expect(result.data?.reason).toBe('expired');
    harness.tokenManager.stop();
  });

  it('returns exists=false when code is unknown', async () => {
    const mock = buildMockFetch({
      graphqlResponses: [graphqlOk({ codeDiscountNodes: { edges: [] } })],
    });
    const harness = buildToolHarness(mock.fetch);
    const result = await harness.call<{ exists: boolean }>(
      'validate_discount_code',
      { code: 'NEVEREXISTED' },
    );
    expect(result.data?.exists).toBe(false);
    harness.tokenManager.stop();
  });
});
