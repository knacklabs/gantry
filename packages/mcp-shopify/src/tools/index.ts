import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShopifyClient } from '../shopify/client.js';
import type { CustomerIdentityCache } from '../privacy/customer-identity-cache.js';
import { registerLookupCustomer } from './lookup-customer.js';
import { registerGetOrder } from './get-order.js';
import { registerListOrdersForCustomer } from './list-orders-for-customer.js';
import { registerGetOrderHistory } from './get-order-history.js';
import { registerSearchProducts } from './search-products.js';
import { registerGetProduct } from './get-product.js';
import { registerCheckInventory } from './check-inventory.js';
import { registerValidateDiscountCode } from './validate-discount-code.js';

export const REGISTERED_TOOL_NAMES = [
  'lookup_customer',
  'get_order',
  'list_orders_for_customer',
  'get_order_history',
  'search_products',
  'get_product',
  'check_inventory',
  'validate_discount_code',
] as const;

export type RegisteredToolName = (typeof REGISTERED_TOOL_NAMES)[number];

const FORBIDDEN_PREFIX_RE =
  /^(apply|create|update|delete|cancel|modify|write|set)_/;

export function assertReadOnlyToolNames(names: ReadonlyArray<string>): void {
  const violations = names.filter((name) => FORBIDDEN_PREFIX_RE.test(name));
  if (violations.length > 0) {
    throw new Error(
      `Read-only enforcement: tool names violate write-prefix policy: ${violations.join(', ')}`,
    );
  }
}

export interface RegisterAllToolsOptions {
  identityCache?: CustomerIdentityCache;
  requireVerifiedIdentity?: boolean;
}

export function registerAllTools(
  server: McpServer,
  client: ShopifyClient,
  options: RegisterAllToolsOptions = {},
): void {
  assertReadOnlyToolNames(REGISTERED_TOOL_NAMES);
  registerLookupCustomer(server, client, {
    requireVerifiedIdentity: options.requireVerifiedIdentity ?? false,
  });
  registerGetOrder(server, client, {
    requireVerifiedIdentity: options.requireVerifiedIdentity ?? false,
  });
  registerListOrdersForCustomer(server, client, {
    identityCache: options.identityCache,
    requireVerifiedIdentity: options.requireVerifiedIdentity ?? false,
  });
  registerGetOrderHistory(server, client, {
    identityCache: options.identityCache,
    requireVerifiedIdentity: options.requireVerifiedIdentity ?? false,
  });
  registerSearchProducts(server, client);
  registerGetProduct(server, client);
  registerCheckInventory(server, client);
  registerValidateDiscountCode(server, client);
}
