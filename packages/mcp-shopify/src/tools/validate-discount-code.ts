import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VALIDATE_DISCOUNT_CODE } from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { jsonContent, toolErrorContent } from './shared.js';

const inputSchema = {
  code: z.string().min(1).describe('Discount code as entered by the customer'),
  cartTotal: z
    .number()
    .nonnegative()
    .optional()
    .describe(
      "Optional cart subtotal. When supplied, the response includes meetsMinimum: true|false. If the discount has no minimum requirement, meetsMinimum is true (anything meets 'no minimum').",
    ),
};

interface DiscountNodesResponse {
  codeDiscountNodes: {
    edges: Array<{
      node: {
        id: string;
        codeDiscount: {
          __typename: string;
          title?: string;
          status?: string;
          startsAt?: string | null;
          endsAt?: string | null;
          minimumRequirement?: {
            greaterThanOrEqualToSubtotal?: {
              amount: string;
              currencyCode: string;
            };
          } | null;
          customerGets?: { items?: { __typename?: string } | null } | null;
        };
      };
    }>;
  };
}

function appliesToFromTypename(name: string | undefined): 'ALL' | 'COLLECTION' | 'PRODUCT' | undefined {
  if (!name) return undefined;
  if (name.includes('All')) return 'ALL';
  if (name.includes('Collection')) return 'COLLECTION';
  if (name.includes('Product')) return 'PRODUCT';
  return undefined;
}

export function registerValidateDiscountCode(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    'validate_discount_code',
    'Read-only validation of a discount code: existence, active status, minimum-order rules. Never applies the code.',
    inputSchema,
    async (args) => {
      try {
        const data = await client.graphql<DiscountNodesResponse>(
          VALIDATE_DISCOUNT_CODE,
          { query: `title:${args.code}` },
        );
        const edges = data.codeDiscountNodes?.edges ?? [];
        const match = edges.find(
          (edge) =>
            (edge.node.codeDiscount.title ?? '').toLowerCase() ===
            args.code.toLowerCase(),
        );
        if (!match) {
          return jsonContent({
            exists: false,
            active: false,
          });
        }
        const discount = match.node.codeDiscount;
        const status = discount.status ?? 'ACTIVE';
        const active = status.toUpperCase() === 'ACTIVE';
        const minimumAmount = discount.minimumRequirement
          ?.greaterThanOrEqualToSubtotal?.amount;
        const minimumOrderAmount = minimumAmount
          ? Number.parseFloat(minimumAmount)
          : undefined;
        let meetsMinimum: boolean | undefined;
        if (typeof args.cartTotal === 'number') {
          meetsMinimum =
            typeof minimumOrderAmount === 'number'
              ? args.cartTotal >= minimumOrderAmount
              : true;
        }
        let reason: string | undefined;
        if (!active) {
          reason = status.toUpperCase() === 'EXPIRED' ? 'expired' : status;
        } else if (meetsMinimum === false) {
          reason = `cart total below minimum ${minimumOrderAmount}`;
        }
        const result: Record<string, unknown> = {
          exists: true,
          active,
        };
        if (typeof minimumOrderAmount === 'number')
          result.minimumOrderAmount = minimumOrderAmount;
        if (meetsMinimum !== undefined) result.meetsMinimum = meetsMinimum;
        const appliesTo = appliesToFromTypename(
          discount.customerGets?.items?.__typename,
        );
        if (appliesTo) result.appliesTo = appliesTo;
        if (discount.endsAt) result.expiresAt = discount.endsAt;
        if (reason) result.reason = reason;
        return jsonContent(result);
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
