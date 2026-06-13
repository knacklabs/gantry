import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LIST_ORDERS_FOR_CUSTOMER } from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { resolveEffectiveIdentity } from '../privacy/effective-identity.js';
import {
  assertCustomerBelongsToCaller,
  normalizeShopifyCustomerId,
} from '../privacy/customer-belongs-to-caller.js';
import type { CustomerIdentityCache } from '../privacy/customer-identity-cache.js';
import type { ShopifyOrder } from '../shopify/types.js';
import { jsonContent, mapOrderResponse, toolErrorContent } from './shared.js';

const inputSchema = {
  customerId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Shopify customer GID or numeric ID. Omit in customer conversations to default to the verified caller (recommended — no lookup_customer step needed).',
    ),
  callerPhone: z
    .string()
    .min(4)
    .optional()
    .describe(
      'Customer phone number. In customer conversations, this must match the phone number being used to message.',
    ),
  callerEmail: z
    .string()
    .email()
    .optional()
    .describe(
      'Customer email. In customer conversations, this must belong to the same customer as the phone number being used to message.',
    ),
  statusFilter: z.enum(['OPEN', 'CLOSED', 'ANY']).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe('How many recent orders to return with full detail (default 1).'),
};

interface OrderEdgesResponse {
  orders: { edges: Array<{ node: Parameters<typeof mapOrderResponse>[0] }> };
}

function statusQuery(filter: 'OPEN' | 'CLOSED' | 'ANY'): string {
  switch (filter) {
    case 'CLOSED':
      return 'status:closed';
    case 'ANY':
      return 'status:any';
    case 'OPEN':
    default:
      return 'status:open';
  }
}

// Detail projection for order-status answers: everything the agent needs to
// say what was ordered and where it is, and nothing else (the caller is
// already verified, so no customer block; no GIDs or SKUs — `name` is the
// handle a follow-up get_order accepts).
export function detailedOrder(order: ShopifyOrder) {
  return {
    name: order.name,
    createdAt: order.createdAt,
    dispatchedAt: order.dispatchedAt,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    total: order.totalPriceSet,
    discountCodes: order.discountCodes,
    shippingAddress: order.shippingAddress,
    items: order.lineItems.map((item) => ({
      title: item.title,
      quantity: item.quantity,
    })),
    fulfillments: order.fulfillments,
  };
}

export function registerGetRecentOrdersWithDetails(
  server: McpServer,
  client: ShopifyClient,
  options: {
    identityCache?: CustomerIdentityCache;
    requireVerifiedIdentity?: boolean;
  } = {},
): void {
  server.tool(
    'get_recent_orders_with_details',
    "PREFERRED single call for order-status questions ('my last order', 'where is my order', 'what did I order'): returns the verified caller's most recent order WITH line items, totals, and delivery/tracking status by default — no follow-up get_order needed. Defaults to ALL statuses sorted newest first, so the first result is the customer's true most recent order. Pass limit only when the customer asks for multiple recent orders.",
    inputSchema,
    async (args) => {
      try {
        const requireVerifiedIdentity =
          options.requireVerifiedIdentity ?? false;
        const hasCallerIdentity = Boolean(args.callerPhone || args.callerEmail);
        const identity =
          requireVerifiedIdentity || hasCallerIdentity
            ? resolveEffectiveIdentity({
                callerPhone: args.callerPhone,
                callerEmail: args.callerEmail,
                requireVerifiedIdentity,
              })
            : null;
        const ownership = identity
          ? await assertCustomerBelongsToCaller(
              client,
              identity,
              args.customerId,
              options.identityCache,
            )
          : null;

        // ALL statuses by default for the same reason as
        // list_orders_for_customer: "most recent order" means newest overall,
        // not newest unfulfilled.
        const filter = args.statusFilter ?? 'ANY';
        const limit = args.limit ?? 1;
        const customerToken =
          ownership?.resolvedId.split('/').pop() ??
          (args.customerId
            ? normalizeShopifyCustomerId(args.customerId)
            : undefined);
        if (!customerToken) {
          return toolErrorContent(
            'INVALID_REQUEST',
            'customerId is required when there is no verified caller identity',
          );
        }
        const query = `customer_id:${customerToken} ${statusQuery(filter)}`;
        const data = await client.graphql<OrderEdgesResponse>(
          LIST_ORDERS_FOR_CUSTOMER,
          { query, first: limit, reverse: true },
        );
        const orders = (data.orders?.edges ?? [])
          .map((edge) => detailedOrder(mapOrderResponse(edge.node)))
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return jsonContent({
          orders,
          ...(ownership && identity
            ? {
                matchedVia: ownership.matchedVia,
                identitySource: identity.source,
              }
            : {}),
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- MCP tool boundary returns customer-safe structured tool errors.
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
