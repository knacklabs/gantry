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
    }>('search_products', { query: 'kaju katli' });

    expect(result.error).toBeUndefined();
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
