import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ShopifyAdapterError } from '../errors.js';
import { FIND_ORDER_BY_NAME } from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { verifyIdentity } from '../privacy/guard.js';
import { resolveEffectiveIdentity } from '../privacy/effective-identity.js';
import { customerVerifiedPhoneNotFoundError } from '../privacy/customer-safe-response.js';
import {
  buildOrderQueryClause,
  jsonContent,
  mapOrderResponse,
  toolErrorContent,
} from './shared.js';

const inputSchema = {
  orderNumber: z
    .string()
    .min(1)
    .describe(
      'Order identifier — accepts the display name (e.g. #1001 or BSS-2847), the numeric Shopify ID (e.g. 7057409966300), or the full GID (gid://shopify/Order/7057409966300).',
    ),
  callerPhone: z
    .string()
    .min(4)
    .optional()
    .describe(
      'Customer phone number. In customer conversations, this must match the phone number being used to message. Operator lookups without channel identity require callerPhone or callerEmail.',
    ),
  callerEmail: z
    .string()
    .email()
    .optional()
    .describe(
      'Customer email address. In customer conversations, this must belong to the same customer as the phone number being used to message. Operator lookups without channel identity require callerPhone or callerEmail.',
    ),
};

interface OrderEdgesResponse {
  orders: { edges: Array<{ node: Parameters<typeof mapOrderResponse>[0] }> };
}

export function registerGetOrder(
  server: McpServer,
  client: ShopifyClient,
  options: { requireVerifiedIdentity?: boolean } = {},
): void {
  server.tool(
    'get_order',
    'Read a Shopify order by order number. In customer conversations, the order must belong to the same customer as the phone number being used to message. Returns full fulfillment, line items, totals.',
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

        const clause = buildOrderQueryClause(args.orderNumber);
        const data = await client.graphql<OrderEdgesResponse>(
          FIND_ORDER_BY_NAME,
          { query: clause.query },
        );
        const edges = data.orders?.edges ?? [];
        const node =
          clause.kind === 'name'
            ? (edges.find(
                (edge) =>
                  edge.node.name.replace(/^#/, '').toLowerCase() ===
                  clause.needle.toLowerCase(),
              )?.node ?? edges[0]?.node)
            : edges[0]?.node;
        if (!node) {
          throw new ShopifyAdapterError(
            'NOT_FOUND',
            `Order ${args.orderNumber} not found`,
          );
        }
        const order = mapOrderResponse(node);
        const guard = identity
          ? verifyIdentity({
              callerPhone: identity.phone,
              callerEmail: identity.email,
              customer: {
                phone: order.customer?.phone ?? null,
                email: order.customer?.email ?? null,
              },
            })
          : null;
        if (guard && !guard.ok) {
          if (requireVerifiedIdentity) {
            throw customerVerifiedPhoneNotFoundError(
              'ORDER_CUSTOMER_MISMATCH',
              `verified phone did not match order ${order.name}`,
            );
          }
          throw new ShopifyAdapterError(
            'PRIVACY_GUARD_FAILED',
            'You can only check details linked to your own account.',
            {
              reason: guard.reason,
              dev: `caller identity could not be verified for order ${order.name}`,
            },
          );
        }
        return jsonContent({
          order: {
            name: order.name,
            displayFinancialStatus: order.displayFinancialStatus,
            displayFulfillmentStatus: order.displayFulfillmentStatus,
            fulfillments: order.fulfillments,
            lineItems: order.lineItems,
            totalPriceSet: order.totalPriceSet,
            shippingAddress: order.shippingAddress,
            createdAt: order.createdAt,
            dispatchedAt: order.dispatchedAt,
            customerId: order.customerId,
            discountCodes: order.discountCodes,
          },
          ...(guard
            ? { matchedVia: guard.matchedVia, identitySource: identity?.source }
            : {}),
        });
        // eslint-disable-next-line no-catch-all/no-catch-all -- MCP tool boundary returns customer-safe structured tool errors.
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
