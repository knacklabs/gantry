import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SEARCH_PRODUCTS } from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { jsonContent, mapProductResponse, toolErrorContent } from './shared.js';
import type { ProductSearchCache } from './product-search-cache.js';

const inputSchema = {
  query: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']).optional(),
  priceMin: z.number().nonnegative().optional(),
  priceMax: z.number().nonnegative().optional(),
  maxPrice: z
    .number()
    .nonnegative()
    .optional()
    .describe('Compatibility alias for priceMax. Prefer priceMax.'),
  limit: z.number().int().min(1).max(50).optional(),
};

interface ProductEdgesResponse {
  products: {
    edges: Array<{ node: Parameters<typeof mapProductResponse>[0] }>;
  };
}

export type ProductSearchSummary = Pick<
  ReturnType<typeof mapProductResponse>,
  'id' | 'handle' | 'title' | 'priceRange' | 'available'
>;

interface EmptyProductReplyContract {
  status: 'success';
  mustNotUseHiccupWording: boolean;
  emptyProductResult: boolean;
}

interface GiftProductReplyContract {
  status: 'success';
  mustLeadWithWebsiteOrdering: boolean;
  mustNotGuaranteeLiveStock: boolean;
  mustSuggestAtMostThreeProducts: boolean;
  mustPresentProductsAsAlternatives: boolean;
}

interface ProductDetailReplyContract {
  status: 'success';
  useCustomerReplyDraft: false;
  mustCallGetProductBeforeAnswer: boolean;
  mustNotSearchAgain: boolean;
}

interface ProductDetailNextTool {
  name: 'get_product';
  arguments: {
    id: string;
  };
  reason: string;
}

interface EmptyProductReplyFacts {
  emptyResult: {
    target: string;
  };
}

interface GiftProductReplyFacts {
  recommendation: {
    route: 'personal_gifting';
    websiteFirst: boolean;
    presentation: 'alternatives';
    maxSuggestions: number;
    budgetMax?: number;
    matchedQuery?: string;
  };
}

function isGiftProductSearch(args: { query?: string; tag?: string }): boolean {
  const text = `${args.query ?? ''} ${args.tag ?? ''}`.toLowerCase();
  return /\b(gift|gifting|birthday|present|hamper)\b/.test(text);
}

function needsProductDetailLookup(args: {
  query?: string;
  tag?: string;
}): boolean {
  const text = `${args.query ?? ''} ${args.tag ?? ''}`.toLowerCase();
  return (
    !isGiftProductSearch(args) &&
    /\b(piece|pieces|count|inside|contents?|weight|grams?|box)\b/.test(text)
  );
}

function isLikelyExactProductLookup(args: {
  query?: string;
  tag?: string;
  priceMin?: number;
  priceMax?: number;
}): boolean {
  const query = args.query?.trim().toLowerCase();
  if (!query || args.tag) return false;
  if (typeof args.priceMin === 'number' || typeof args.priceMax === 'number') {
    return false;
  }
  if (isGiftProductSearch(args)) return false;
  if (
    /\b(recommend|suggest|options?|under|below|budget|all|list|show|search|category|products?)\b/.test(
      query,
    )
  ) {
    return false;
  }
  return query.split(/\s+/).length <= 5;
}

function isBulkOrEventGiftSearch(args: {
  query?: string;
  tag?: string;
}): boolean {
  const text = `${args.query ?? ''} ${args.tag ?? ''}`.toLowerCase();
  return /\b(bulk|corporate|client|clients|employee|employees|guest|guests|wedding|gst|logo|branding|quote|procurement|multi-city|pan-india)\b/.test(
    text,
  );
}

function shouldAttachGiftProductReplyFacts(args: {
  query?: string;
  tag?: string;
}): boolean {
  return isGiftProductSearch(args) && !isBulkOrEventGiftSearch(args);
}

function fallbackProductQuery(args: {
  query?: string;
  tag?: string;
}): string | undefined {
  if (args.tag) return undefined;
  if (isBulkOrEventGiftSearch(args)) return undefined;
  const query = args.query?.trim().toLowerCase();
  if (!query) return undefined;
  if (!/\b(gift|gifting|birthday|present|hamper)\b/.test(query)) {
    return undefined;
  }
  if (query === 'gift box') return undefined;
  return 'gift box';
}

export function buildProductQuery(args: {
  query?: string;
  tag?: string;
  status?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  priceMin?: number;
  priceMax?: number;
}): string {
  const tokens: string[] = [];
  if (args.query) tokens.push(args.query);
  if (args.tag) tokens.push(`tag:${args.tag}`);
  tokens.push(`status:${(args.status ?? 'ACTIVE').toLowerCase()}`);
  if (typeof args.priceMin === 'number')
    tokens.push(`variants.price:>=${args.priceMin}`);
  if (typeof args.priceMax === 'number')
    tokens.push(`variants.price:<=${args.priceMax}`);
  return tokens.join(' ').trim();
}

export function compactProductSearchSummary(
  product: ReturnType<typeof mapProductResponse>,
): ProductSearchSummary {
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    priceRange: product.priceRange,
    available: product.available,
  };
}

function buildEmptyProductReplyFacts(args: {
  query?: string;
  tag?: string;
}): EmptyProductReplyFacts {
  const target = args.query?.trim() || args.tag?.trim() || 'a matching product';
  return {
    emptyResult: {
      target,
    },
  };
}

function emptyProductReplyContract(): EmptyProductReplyContract {
  return {
    status: 'success',
    mustNotUseHiccupWording: true,
    emptyProductResult: true,
  };
}

function giftProductReplyContract(): GiftProductReplyContract {
  return {
    status: 'success',
    mustLeadWithWebsiteOrdering: true,
    mustNotGuaranteeLiveStock: true,
    mustSuggestAtMostThreeProducts: true,
    mustPresentProductsAsAlternatives: true,
  };
}

function productDetailReplyContract(): ProductDetailReplyContract {
  return {
    status: 'success',
    useCustomerReplyDraft: false,
    mustCallGetProductBeforeAnswer: true,
    mustNotSearchAgain: true,
  };
}

function productDetailNextTool(
  product: ProductSearchSummary,
): ProductDetailNextTool {
  return {
    name: 'get_product',
    arguments: { id: product.id },
    reason:
      'The customer asked for count, contents, weight, or box details; search_products is compact, so get_product is required before answering.',
  };
}

function isAccessoryOnlyProduct(product: ProductSearchSummary): boolean {
  const text = `${product.handle} ${product.title}`.toLowerCase();
  return /\b(gift[- ]?bag|bag|wrapping|wrap|gift[- ]?wrap)\b/.test(text);
}

function buildGiftProductReplyFacts(input: {
  budgetMax: number | undefined;
  matchedQuery: string | undefined;
}): GiftProductReplyFacts {
  return {
    recommendation: {
      route: 'personal_gifting',
      websiteFirst: true,
      presentation: 'alternatives',
      maxSuggestions: 3,
      ...(typeof input.budgetMax === 'number'
        ? { budgetMax: input.budgetMax }
        : {}),
      ...(input.matchedQuery ? { matchedQuery: input.matchedQuery } : {}),
    },
  };
}

export function registerSearchProducts(
  server: McpServer,
  client: ShopifyClient,
  options: { productSearchCache?: ProductSearchCache } = {},
): void {
  server.tool(
    'search_products',
    'Search the store catalogue by one targeted query, tag, status, or price band. Returns compact product summaries; exact product-detail asks may include nextTool=get_product. Defaults to ACTIVE products and a compact 3-product result.',
    inputSchema,
    async (args) => {
      const limit = args.limit ?? 3;
      const priceMax = args.priceMax ?? args.maxPrice;
      const query = buildProductQuery({
        ...args,
        priceMax,
      });
      try {
        const fetchProducts = async (productQuery: string) => {
          const cacheKey = JSON.stringify({
            query: productQuery,
            first: limit,
          });
          const data = await (options.productSearchCache?.getOrLoad(
            cacheKey,
            () =>
              client.graphql<ProductEdgesResponse>(SEARCH_PRODUCTS, {
                query: productQuery,
                first: limit,
              }),
          ) ??
            client.graphql<ProductEdgesResponse>(SEARCH_PRODUCTS, {
              query: productQuery,
              first: limit,
            }));
          const products = (data.products?.edges ?? []).map((edge) =>
            mapProductResponse(edge.node),
          );
          let filtered = products;
          if (typeof args.priceMin === 'number') {
            filtered = filtered.filter(
              (p) =>
                Number.parseFloat(p.priceRange.minVariantPrice) >=
                args.priceMin!,
            );
          }
          if (typeof priceMax === 'number') {
            filtered = filtered.filter(
              (p) =>
                Number.parseFloat(p.priceRange.maxVariantPrice) <= priceMax,
            );
          }
          return filtered.map(compactProductSearchSummary);
        };

        let summaries = await fetchProducts(query);
        let matchedQuery: string | undefined;
        if (summaries.length === 0) {
          const fallback = fallbackProductQuery(args);
          if (fallback) {
            const fallbackQuery = buildProductQuery({
              status: args.status,
              query: fallback,
              priceMin: args.priceMin,
              priceMax,
            });
            summaries = await fetchProducts(fallbackQuery);
            if (summaries.length > 0) matchedQuery = fallback;
          }
        }
        if (summaries.length === 0) {
          return jsonContent({
            replyContract: emptyProductReplyContract(),
            replyFacts: buildEmptyProductReplyFacts(args),
            products: summaries,
          });
        }
        const attachGiftProductReplyFacts =
          shouldAttachGiftProductReplyFacts(args);
        const nonAccessoryProducts = summaries.filter(
          (product) => !isAccessoryOnlyProduct(product),
        );
        const responseProducts = attachGiftProductReplyFacts
          ? (nonAccessoryProducts.length > 0
              ? nonAccessoryProducts
              : summaries
            ).slice(0, 3)
          : summaries;
        const attachProductDetailNextTool =
          !attachGiftProductReplyFacts &&
          (needsProductDetailLookup(args) ||
            isLikelyExactProductLookup({ ...args, priceMax })) &&
          responseProducts.length > 0;
        return jsonContent({
          ...(attachGiftProductReplyFacts
            ? {
                replyContract: giftProductReplyContract(),
                replyFacts: buildGiftProductReplyFacts({
                  budgetMax: priceMax,
                  matchedQuery,
                }),
              }
            : {}),
          ...(attachProductDetailNextTool
            ? {
                replyContract: productDetailReplyContract(),
                nextTool: productDetailNextTool(responseProducts[0]!),
              }
            : {}),
          products: responseProducts,
          ...(matchedQuery ? { matchedQuery } : {}),
        });
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
