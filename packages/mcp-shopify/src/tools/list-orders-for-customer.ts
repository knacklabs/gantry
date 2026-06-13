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
import {
  jsonContent,
  mapOrderResponse,
  summarizeOrder,
  toolErrorContent,
} from './shared.js';

const inputSchema = {
  customerId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Shopify customer GID or numeric ID. Omit in customer conversations to default to the verified caller (recommended — no lookup_customer step needed). If supplied, it must belong to the same customer as the phone number being used to message.',
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
  limit: z.number().int().min(1).max(25).optional(),
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

export function registerListOrdersForCustomer(
  server: McpServer,
  client: ShopifyClient,
  options: {
    identityCache?: CustomerIdentityCache;
    requireVerifiedIdentity?: boolean;
  } = {},
): void {
  server.tool(
    'list_orders_for_customer',
    "List recent Shopify orders for the verified caller (matched by phone/email). Defaults to ALL statuses (open + fulfilled/closed), sorted newest first, so the first result is the customer's true most recent order. Pass statusFilter: 'OPEN' to see only unfulfilled orders.",
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

        // Default to ALL statuses: a customer asking for their "most recent /
        // last order" means newest overall, including already-fulfilled orders.
        // Defaulting to OPEN here would report the most recent UNFULFILLED order
        // and miss a newer delivered one. Callers wanting only open orders pass
        // statusFilter: 'OPEN' explicitly.
        const filter = args.statusFilter ?? 'ANY';
        const limit = args.limit ?? 10;
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
          .map((edge) => summarizeOrder(mapOrderResponse(edge.node)))
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
