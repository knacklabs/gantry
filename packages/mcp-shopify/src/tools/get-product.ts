import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GET_PRODUCT_BY_HANDLE,
  GET_PRODUCT_BY_ID,
} from '../shopify/queries.js';
import type { ShopifyClient } from '../shopify/client.js';
import { jsonContent, mapProductResponse, toolErrorContent } from './shared.js';

const inputSchema = {
  handleOrId: z
    .string()
    .min(1)
    .optional()
    .describe('Product handle (e.g. "blue-t-shirt") or full GID'),
  handle: z
    .string()
    .min(1)
    .optional()
    .describe('Compatibility alias for handleOrId. Prefer handleOrId.'),
  id: z
    .string()
    .min(1)
    .optional()
    .describe('Compatibility alias for handleOrId when passing a full GID.'),
};

interface ProductByHandleResponse {
  productByHandle:
    | (Parameters<typeof mapProductResponse>[0] & { __typename?: string })
    | null;
}

interface ProductByIdResponse {
  product: Parameters<typeof mapProductResponse>[0] | null;
}

export function registerGetProduct(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    'get_product',
    'Read a single product by handle or GID. Returns null when not found.',
    inputSchema,
    async (args) => {
      try {
        const handleOrId = args.handleOrId ?? args.handle ?? args.id;
        if (!handleOrId) {
          return toolErrorContent(
            'INVALID_REQUEST',
            'handleOrId is required',
          );
        }
        if (handleOrId.startsWith('gid://')) {
          const data = await client.graphql<ProductByIdResponse>(
            GET_PRODUCT_BY_ID,
            { id: handleOrId },
          );
          if (!data.product) return jsonContent({ product: null });
          return jsonContent({ product: mapProductResponse(data.product) });
        }
        const data = await client.graphql<ProductByHandleResponse>(
          GET_PRODUCT_BY_HANDLE,
          { handle: handleOrId },
        );
        if (!data.productByHandle) return jsonContent({ product: null });
        return jsonContent({
          product: mapProductResponse(data.productByHandle),
        });
      } catch (err) {
        return toolErrorContent(err);
      }
    },
  );
}
