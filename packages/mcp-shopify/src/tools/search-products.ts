import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SEARCH_PRODUCTS } from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { jsonContent, mapProductResponse, toolErrorContent } from './shared.js';

const inputSchema = {
  query: z.string().optional(),
  tag: z.string().optional(),
  status: z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']).optional(),
  priceMin: z.number().nonnegative().optional(),
  priceMax: z.number().nonnegative().optional(),
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

export function registerSearchProducts(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    'search_products',
    'Search the store catalogue by query, tag, status, or price band. Defaults to ACTIVE products.',
    inputSchema,
    async (args) => {
      const limit = args.limit ?? 10;
      const query = buildProductQuery(args);
      try {
        const data = await client.graphql<ProductEdgesResponse>(
          SEARCH_PRODUCTS,
          { query, first: limit },
        );
        const products = (data.products?.edges ?? []).map((edge) =>
          mapProductResponse(edge.node),
        );
        let filtered = products;
        if (typeof args.priceMin === 'number') {
          filtered = filtered.filter(
            (p) =>
              Number.parseFloat(p.priceRange.minVariantPrice) >= args.priceMin!,
          );
        }
        if (typeof args.priceMax === 'number') {
          filtered = filtered.filter(
            (p) =>
              Number.parseFloat(p.priceRange.maxVariantPrice) <= args.priceMax!,
          );
        }
        const summaries = filtered.map(compactProductSearchSummary);
        return jsonContent({
          products: summaries,
        });
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
