import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  LIST_ORDERS_FOR_CUSTOMER,
  SEARCH_PRODUCTS,
} from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { resolveEffectiveIdentity } from '../privacy/effective-identity.js';
import {
  assertCustomerBelongsToCaller,
  normalizeShopifyCustomerId,
} from '../privacy/customer-belongs-to-caller.js';
import type { CustomerIdentityCache } from '../privacy/customer-identity-cache.js';
import { detailedOrder } from './get-recent-orders-with-details.js';
import {
  buildProductQuery,
  compactProductSearchSummary,
  type ProductSearchSummary,
} from './search-products.js';
import type { ProductSearchCache } from './product-search-cache.js';
import {
  jsonContent,
  mapOrderResponse,
  mapProductResponse,
  toolErrorContent,
} from './shared.js';

const DEFAULT_PRODUCT_QUERIES = ['premium festive hamper gift box'];
const deliveryLocationsSchema = z
  .union([z.array(z.string().min(1)).max(8), z.string().min(1)])
  .optional();
const optionalBriefTextSchema = z
  .union([z.string().min(1), z.literal(false)])
  .optional();

const inputSchema = {
  includeLatestOrder: z
    .boolean()
    .optional()
    .describe(
      'Include the verified caller’s latest order details. Defaults to false; set true only when the customer asks to use prior/latest-order context.',
    ),
  customerId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Shopify customer GID or numeric ID. Omit in customer conversations to default to the verified caller.',
    ),
  callerPhone: z.string().min(4).optional(),
  callerEmail: z.string().email().optional(),
  productQueries: z
    .array(z.string().min(1))
    .max(4)
    .optional()
    .describe(
      'One to four targeted product search queries for the gifting brief.',
    ),
  productQuery: z
    .string()
    .min(1)
    .optional()
    .describe('Compatibility alias for a single productQueries entry.'),
  maxProductsPerQuery: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe('Maximum products to fetch for each query. Defaults to 3.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(8)
    .optional()
    .describe(
      'Compatibility alias for maxProductsPerQuery. Prefer maxProductsPerQuery.',
    ),
  budgetMax: z.number().nonnegative().optional(),
  budget: z
    .number()
    .nonnegative()
    .optional()
    .describe('Compatibility alias for budgetMax. Prefer budgetMax.'),
  maxPrice: z
    .number()
    .nonnegative()
    .optional()
    .describe('Compatibility alias for budgetMax. Prefer budgetMax.'),
  occasion: optionalBriefTextSchema
    .optional()
    .describe(
      'Known gifting occasion, such as Diwali, wedding, or client gifts.',
    ),
  quantity: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Known gift quantity from the customer brief.'),
  deliveryLocations: deliveryLocationsSchema.describe(
    'Known delivery location or locations from the customer brief.',
  ),
  delivery_locations: deliveryLocationsSchema.describe(
    'Compatibility alias for deliveryLocations.',
  ),
  timeline: optionalBriefTextSchema
    .optional()
    .describe('Known delivery timeline from the customer brief.'),
  branding: optionalBriefTextSchema
    .optional()
    .describe('Known logo, custom message, or branding requirement.'),
};

interface OrderEdgesResponse {
  orders: { edges: Array<{ node: Parameters<typeof mapOrderResponse>[0] }> };
}

interface ProductEdgesResponse {
  products: {
    edges: Array<{ node: Parameters<typeof mapProductResponse>[0] }>;
  };
}

type GiftingProductSummary = ProductSearchSummary & {
  matchedQueries: string[];
};

interface GiftingAnswerGuidance {
  latestOrderLine: string;
  productLine: string;
}

interface GiftingReplyContract {
  status: 'success';
  mustMentionLatestOrderName: string;
  mustNotUseHiccupWording: boolean;
}

interface GiftingReplyFacts {
  latestOrder: {
    name: string;
    firstItem?: {
      title: string;
      quantity: number;
    };
  };
  brief: {
    occasion?: string;
    quantity?: number;
    budgetMax?: number;
    deliveryLocations: string[];
    timeline?: string;
    branding?: string;
  };
  productCuration: {
    owner: 'gifting_team';
    reason: 'qualified_gifting_brief';
  };
}

interface GiftingBrief {
  occasion?: string;
  quantity?: number;
  budgetMax?: number;
  deliveryLocations: string[];
  timeline?: string;
  branding?: string;
}

function statusAnyQuery(customerToken: string): string {
  return `customer_id:${customerToken} status:any`;
}

function withinBudget(
  product: ReturnType<typeof mapProductResponse>,
  budgetMax: number | undefined,
): boolean {
  if (typeof budgetMax !== 'number') return true;
  return Number.parseFloat(product.priceRange.minVariantPrice) <= budgetMax;
}

function normalizeDeliveryLocations(
  value: string | string[] | undefined,
): string[] {
  if (!value) return [];
  const rawLocations = Array.isArray(value)
    ? value
    : value.split(/\s*(?:,|;|\band\b|&)\s*/i);
  return [
    ...new Set(rawLocations.map((location) => location.trim()).filter(Boolean)),
  ].slice(0, 8);
}

function normalizeBriefText(
  value: string | false | undefined,
): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeGiftingBrief(args: {
  occasion?: string | false;
  quantity?: number;
  budgetMax?: number;
  budget?: number;
  maxPrice?: number;
  deliveryLocations?: string | string[];
  delivery_locations?: string | string[];
  timeline?: string | false;
  branding?: string | false;
}): GiftingBrief {
  return {
    occasion: normalizeBriefText(args.occasion),
    quantity:
      typeof args.quantity === 'number' && Number.isFinite(args.quantity)
        ? args.quantity
        : undefined,
    budgetMax: args.budgetMax ?? args.budget ?? args.maxPrice,
    deliveryLocations: normalizeDeliveryLocations(
      args.deliveryLocations ?? args.delivery_locations,
    ),
    timeline: normalizeBriefText(args.timeline),
    branding: normalizeBriefText(args.branding),
  };
}

function isQualifiedGiftingBrief(brief: GiftingBrief): boolean {
  if (typeof brief.quantity === 'number' && brief.quantity >= 25) return true;
  if (brief.deliveryLocations.length > 0 && typeof brief.budgetMax === 'number')
    return true;
  return Boolean(brief.occasion && typeof brief.budgetMax === 'number');
}

function buildAnswerGuidance(input: {
  latestOrder: ReturnType<typeof detailedOrder> | null;
  products: GiftingProductSummary[];
}): GiftingAnswerGuidance | undefined {
  if (!input.latestOrder || input.products.length > 0) return undefined;
  return {
    latestOrderLine: `Mention latest order ${input.latestOrder.name} and one detail from it before the gifting brief.`,
    productLine:
      'Product curation is team-owned for this brief; say the gifting team will curate options without treating it as a live-data failure.',
  };
}

function buildReplyContract(input: {
  latestOrder: ReturnType<typeof detailedOrder> | null;
  products: GiftingProductSummary[];
}): GiftingReplyContract | undefined {
  if (!input.latestOrder || input.products.length > 0) return undefined;
  return {
    status: 'success',
    mustMentionLatestOrderName: input.latestOrder.name,
    mustNotUseHiccupWording: true,
  };
}

function buildReplyFacts(input: {
  latestOrder: ReturnType<typeof detailedOrder> | null;
  products: GiftingProductSummary[];
  brief: GiftingBrief;
}): GiftingReplyFacts | undefined {
  if (!input.latestOrder || input.products.length > 0) return undefined;
  const firstItem = input.latestOrder.items[0];
  return {
    latestOrder: {
      name: input.latestOrder.name,
      ...(firstItem
        ? {
            firstItem: {
              title: firstItem.title,
              quantity: firstItem.quantity,
            },
          }
        : {}),
    },
    brief: {
      ...(input.brief.occasion ? { occasion: input.brief.occasion } : {}),
      ...(input.brief.quantity ? { quantity: input.brief.quantity } : {}),
      ...(input.brief.budgetMax ? { budgetMax: input.brief.budgetMax } : {}),
      deliveryLocations: input.brief.deliveryLocations,
      ...(input.brief.timeline ? { timeline: input.brief.timeline } : {}),
      ...(input.brief.branding ? { branding: input.brief.branding } : {}),
    },
    productCuration: {
      owner: 'gifting_team',
      reason: 'qualified_gifting_brief',
    },
  };
}

function compactLatestOrderForReply(
  order: ReturnType<typeof detailedOrder> | null,
) {
  if (!order) return null;
  return {
    name: order.name,
    items: order.items,
    total: order.total,
    financialStatus: order.financialStatus,
    fulfillmentStatus: order.fulfillmentStatus,
  };
}

export function registerGetGiftingContext(
  server: McpServer,
  client: ShopifyClient,
  options: {
    identityCache?: CustomerIdentityCache;
    productSearchCache?: ProductSearchCache;
    requireVerifiedIdentity?: boolean;
  } = {},
): void {
  server.tool(
    'get_gifting_context',
    'Aggregate helper for gifting requests that explicitly need latest-order context or a single targeted product query. Latest order is excluded unless includeLatestOrder=true. For simple personal gift recommendations, prefer one search_products call unless previous-order context is requested.',
    inputSchema,
    async (args) => {
      try {
        const includeLatestOrder = args.includeLatestOrder ?? false;
        const brief = normalizeGiftingBrief(args);
        let requestedQueries: string[];
        if (args.productQueries?.length) {
          requestedQueries = args.productQueries;
        } else if (args.productQuery?.trim()) {
          requestedQueries = [args.productQuery.trim()];
        } else if (isQualifiedGiftingBrief(brief)) {
          requestedQueries = [];
        } else {
          requestedQueries = DEFAULT_PRODUCT_QUERIES;
        }
        const productQueries = [
          ...new Set(
            requestedQueries.map((query) => query.trim()).filter(Boolean),
          ),
        ].slice(0, 4);
        const maxProductsPerQuery = args.maxProductsPerQuery ?? args.limit ?? 3;
        const budgetMax = args.budgetMax ?? args.budget ?? args.maxPrice;
        const requireVerifiedIdentity =
          options.requireVerifiedIdentity ?? false;
        const hasCallerIdentity = Boolean(args.callerPhone || args.callerEmail);
        const identity =
          includeLatestOrder || requireVerifiedIdentity || hasCallerIdentity
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

        const customerToken =
          ownership?.resolvedId.split('/').pop() ??
          (args.customerId
            ? normalizeShopifyCustomerId(args.customerId)
            : undefined);
        if (includeLatestOrder && !customerToken) {
          return toolErrorContent(
            'INVALID_REQUEST',
            'customerId is required when there is no verified caller identity',
          );
        }

        const latestOrderPromise =
          includeLatestOrder && customerToken
            ? client
                .graphql<OrderEdgesResponse>(LIST_ORDERS_FOR_CUSTOMER, {
                  query: statusAnyQuery(customerToken),
                  first: 1,
                  reverse: true,
                })
                .then((data) => {
                  const order = (data.orders?.edges ?? [])
                    .map((edge) => detailedOrder(mapOrderResponse(edge.node)))
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                  return order ?? null;
                })
            : Promise.resolve(null);

        const productSearchPromises = productQueries.map(async (query) => {
          const productQuery = buildProductQuery({
            query,
            priceMax: budgetMax,
          });
          const cacheKey = JSON.stringify({
            query: productQuery,
            first: maxProductsPerQuery,
          });
          const data = await (options.productSearchCache?.getOrLoad(
            cacheKey,
            () =>
              client.graphql<ProductEdgesResponse>(SEARCH_PRODUCTS, {
                query: productQuery,
                first: maxProductsPerQuery,
              }),
          ) ??
            client.graphql<ProductEdgesResponse>(SEARCH_PRODUCTS, {
              query: productQuery,
              first: maxProductsPerQuery,
            }));
          const products = (data.products?.edges ?? [])
            .map((edge) => mapProductResponse(edge.node))
            .filter((product) => withinBudget(product, budgetMax));
          return { query, products };
        });

        const [latestOrder, productResults] = await Promise.all([
          latestOrderPromise,
          Promise.all(productSearchPromises),
        ]);

        const productsById = new Map<string, GiftingProductSummary>();
        const uniqueCountByQuery = new Map<string, number>();
        for (const result of productResults) {
          uniqueCountByQuery.set(result.query, 0);
          for (const product of result.products) {
            const summary = compactProductSearchSummary(product);
            const existing = productsById.get(summary.id);
            if (existing) {
              existing.matchedQueries.push(result.query);
            } else {
              uniqueCountByQuery.set(
                result.query,
                (uniqueCountByQuery.get(result.query) ?? 0) + 1,
              );
              productsById.set(summary.id, {
                ...summary,
                matchedQueries: [result.query],
              });
            }
          }
        }

        const products = [...productsById.values()];
        const answerGuidance = buildAnswerGuidance({ latestOrder, products });
        const replyContract = buildReplyContract({
          latestOrder,
          products,
        });
        const replyFacts = buildReplyFacts({
          latestOrder,
          products,
          brief,
        });

        return jsonContent({
          ...(replyContract ? { replyContract } : {}),
          ...(replyFacts ? { replyFacts } : {}),
          ...(answerGuidance ? { answerGuidance } : {}),
          latestOrder: replyContract
            ? compactLatestOrderForReply(latestOrder)
            : latestOrder,
          products,
          productQueries: productResults.map((result) => ({
            query: result.query,
            resultCount: uniqueCountByQuery.get(result.query) ?? 0,
          })),
          ...(ownership && identity
            ? {
                matchedVia: ownership.matchedVia,
                identitySource: identity.source,
              }
            : {}),
        });
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
