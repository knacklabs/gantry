import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TokenManager } from '../../src/auth/token-manager.js';
import { ShopifyClient } from '../../src/shopify/client.js';
import { registerAllTools } from '../../src/tools/index.js';
import { loadDotenvUpwards } from '../../src/dotenv-load.js';

loadDotenvUpwards();

const LIVE = process.env.SHOPIFY_LIVE === '1';
const SHOP = process.env.SHOPIFY_DEV_SHOP_DOMAIN ?? '';
const CLIENT_ID = process.env.SHOPIFY_DEV_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SHOPIFY_DEV_CLIENT_SECRET ?? '';
const API_VERSION = process.env.SHOPIFY_DEV_API_VERSION ?? '2026-04';

const ENABLED = LIVE && SHOP !== '' && CLIENT_ID !== '' && CLIENT_SECRET !== '';

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: unknown,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
}

function readRegistry(server: McpServer): Record<string, RegisteredTool> {
  return (
    server as unknown as { _registeredTools: Record<string, RegisteredTool> }
  )._registeredTools;
}

interface LiveHarness {
  tokenManager: TokenManager;
  call: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{
    data?: unknown;
    error?: { code?: string; message: string };
    raw: unknown;
  }>;
}

let harness: LiveHarness;

beforeAll(() => {
  if (!ENABLED) return;
  const tokenManager = new TokenManager({
    shopDomain: SHOP,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  const client = new ShopifyClient({
    shopDomain: SHOP,
    apiVersion: API_VERSION,
    tokenManager,
    maxAttempts: 2,
    initialDelayMs: 50,
    maxDelayMs: 500,
  });
  const server = new McpServer({ name: 'live', version: '0.0.0' });
  registerAllTools(server, client);
  const registry = readRegistry(server);

  harness = {
    tokenManager,
    async call(name, args) {
      const tool = registry[name];
      if (!tool) throw new Error(`tool ${name} not registered`);
      const result = await tool.handler(args, {});
      const text = result.content?.[0]?.text ?? '';
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = text;
      }
      if (
        result.isError ||
        (raw && typeof raw === 'object' && 'error' in (raw as object))
      ) {
        const err = (raw as { error?: { code: string; message: string } })
          .error;
        if (!err && typeof raw === 'string') {
          return { error: { message: raw }, raw };
        }
        return { error: err, raw };
      }
      return { data: raw, raw };
    },
  };
});

afterAll(() => {
  if (ENABLED) harness?.tokenManager.stop();
});

describe.skipIf(!ENABLED)('live Shopify tool integration', () => {
  it('search_products returns at least one active product', async () => {
    const result = await harness.call('search_products', { limit: 5 });
    expect(result.error).toBeUndefined();
    const products = (result.data as { products: Array<{ handle: string }> })
      ?.products;
    expect(Array.isArray(products)).toBe(true);
    expect(products.length).toBeGreaterThanOrEqual(1);
    expect(typeof products[0].handle).toBe('string');
  });

  it('search_products with a price band filters correctly', async () => {
    const result = await harness.call('search_products', {
      priceMin: 0,
      priceMax: 100,
      limit: 25,
    });
    expect(result.error).toBeUndefined();
    const products = (
      result.data as {
        products: Array<{ priceRange: { maxVariantPrice: string } }>;
      }
    )?.products;
    for (const product of products) {
      expect(
        Number.parseFloat(product.priceRange.maxVariantPrice),
      ).toBeLessThanOrEqual(100);
    }
  });

  it('get_product resolves a real handle', async () => {
    const search = await harness.call('search_products', { limit: 1 });
    const handle = (search.data as { products: Array<{ handle: string }> })
      .products[0].handle;
    const result = await harness.call('get_product', { handleOrId: handle });
    expect(result.error).toBeUndefined();
    const product = (result.data as { product: { handle: string } | null })
      .product;
    expect(product?.handle).toBe(handle);
  });

  it('get_product returns null for a non-existent handle', async () => {
    const result = await harness.call('get_product', {
      handleOrId: 'this-handle-does-not-exist-xyz-9999',
    });
    expect(result.error).toBeUndefined();
    expect((result.data as { product: unknown }).product).toBeNull();
  });

  it('check_inventory by productHandle returns total quantity', async () => {
    const search = await harness.call('search_products', { limit: 5 });
    const products = (
      search.data as { products: Array<{ handle: string; available: boolean }> }
    ).products;
    const inStock = products.find((p) => p.available) ?? products[0];
    const result = await harness.call('check_inventory', {
      productHandle: inStock.handle,
      requestedQuantity: 1,
    });
    expect(result.error).toBeUndefined();
    const inventory = result.data as {
      totalQuantity: number;
      outOfStock: boolean;
      sufficient?: boolean;
    };
    expect(typeof inventory.totalQuantity).toBe('number');
    expect(typeof inventory.outOfStock).toBe('boolean');
    expect(typeof inventory.sufficient).toBe('boolean');
  });

  it('validate_discount_code: unknown code returns exists=false', async () => {
    const result = await harness.call('validate_discount_code', {
      code: 'NEVER_EXISTED_XYZ_9999',
    });
    expect(result.error).toBeUndefined();
    expect((result.data as { exists: boolean }).exists).toBe(false);
  });

  it('lookup_customer (phone) returns either a customer or PCD/scope error against the live store', async () => {
    const result = await harness.call('lookup_customer', {
      phone: '+919876543210',
    });
    if (result.error) {
      expect([
        'PROTECTED_DATA_REDACTED',
        'SCOPE_MISSING',
        'ACCESS_DENIED',
        'NOT_FOUND',
      ]).toContain(result.error.code);
    } else {
      expect(result.data).toHaveProperty('found');
    }
  });

  it('lookup_customer (email) returns either a customer or PCD/scope error against the live store', async () => {
    const result = await harness.call('lookup_customer', {
      email: 'never-exists-xyz@example.com',
    });
    if (result.error) {
      expect([
        'PROTECTED_DATA_REDACTED',
        'SCOPE_MISSING',
        'ACCESS_DENIED',
        'NOT_FOUND',
      ]).toContain(result.error.code);
    } else {
      expect(result.data).toHaveProperty('found');
    }
  });

  it('lookup_customer rejects when neither phone nor email is given', async () => {
    const result = await harness.call('lookup_customer', {});
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
  });

  it('get_order returns NOT_FOUND for a non-existent order', async () => {
    const result = await harness.call('get_order', {
      orderNumber: 'BSS-DOES-NOT-EXIST-99999',
      callerPhone: '+919876543210',
    });
    expect(result.error?.code).toMatch(
      /^(NOT_FOUND|PROTECTED_DATA_REDACTED|SCOPE_MISSING)$/,
    );
  });

  it('list_orders_for_customer rejects when caller identity is missing (privacy gate)', async () => {
    const result = await harness.call('list_orders_for_customer', {
      customerId: 'gid://shopify/Customer/0',
      statusFilter: 'OPEN',
    });
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((result.raw as { error: { reason: string } }).error.reason).toBe(
      'NO_IDENTITY',
    );
  });

  it('list_orders_for_customer rejects unknown customerId with a verified caller', async () => {
    const result = await harness.call('list_orders_for_customer', {
      customerId: 'gid://shopify/Customer/0',
      callerPhone: '+919876543210',
      statusFilter: 'OPEN',
    });
    expect(result.error?.code).toMatch(
      /^(PRIVACY_GUARD_FAILED|PROTECTED_DATA_REDACTED)$/,
    );
  });

  it('get_order_history rejects when caller identity is missing', async () => {
    const result = await harness.call('get_order_history', {
      customerId: 'gid://shopify/Customer/0',
    });
    expect(result.error?.code).toBe('PRIVACY_GUARD_FAILED');
    expect((result.raw as { error: { reason: string } }).error.reason).toBe(
      'NO_IDENTITY',
    );
  });

  it('reuses the cached token across many calls', async () => {
    const fetchSpy: Array<string> = [];
    const original = global.fetch;
    global.fetch = (async (input: string | URL, init?: RequestInit) => {
      fetchSpy.push(input.toString());
      return original(input, init);
    }) as typeof fetch;
    try {
      await harness.call('search_products', { limit: 1 });
      await harness.call('search_products', { limit: 1 });
      await harness.call('search_products', { limit: 1 });
    } finally {
      global.fetch = original;
    }
    const tokenCalls = fetchSpy.filter((u) =>
      u.includes('/oauth/access_token'),
    );
    expect(tokenCalls.length).toBe(0);
  });
});

it('integration harness skip placeholder', () => {
  expect(ENABLED || !ENABLED).toBe(true);
});
