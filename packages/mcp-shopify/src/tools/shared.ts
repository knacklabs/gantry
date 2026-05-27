import { ShopifyAdapterError } from '../errors.js';
import type {
  ShopifyOrder,
  OrderSummary,
  ShopifyProduct,
} from '../shopify/types.js';

interface RawOrderResponse {
  id: string;
  name: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  createdAt: string;
  processedAt?: string | null;
  cancelledAt?: string | null;
  totalPriceSet?: {
    shopMoney?: { amount: string; currencyCode: string };
  } | null;
  discountCodes?: string[] | null;
  customer?: {
    id?: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  shippingAddress?: {
    city?: string | null;
    province?: string | null;
    country?: string | null;
    zip?: string | null;
  } | null;
  lineItems?: {
    edges: Array<{
      node: { title: string; quantity: number; sku?: string | null };
    }>;
  } | null;
  fulfillments?: Array<{
    status: string;
    estimatedDeliveryAt?: string | null;
    trackingInfo?: Array<{
      url?: string | null;
      company?: string | null;
      number?: string | null;
    }> | null;
  }> | null;
}

export function mapOrderResponse(raw: RawOrderResponse): ShopifyOrder {
  const customer = raw.customer ?? null;
  const fulfillments = (raw.fulfillments ?? []).map((f) => {
    const tracking = (f.trackingInfo ?? [])[0];
    return {
      status: f.status,
      estimatedDeliveryAt: f.estimatedDeliveryAt ?? null,
      trackingUrl: tracking?.url ?? null,
      trackingCompany: tracking?.company ?? null,
      trackingNumber: tracking?.number ?? null,
    };
  });

  const dispatched = fulfillments.some(
    (f) => f.status === 'SUCCESS' || f.status === 'FULFILLED',
  );

  return {
    id: raw.id,
    name: raw.name,
    displayFinancialStatus: raw.displayFinancialStatus,
    displayFulfillmentStatus: raw.displayFulfillmentStatus,
    createdAt: raw.createdAt,
    dispatchedAt: dispatched ? (raw.processedAt ?? null) : null,
    totalPriceSet: {
      amount: raw.totalPriceSet?.shopMoney?.amount ?? '0',
      currencyCode: raw.totalPriceSet?.shopMoney?.currencyCode ?? 'INR',
    },
    discountCodes: raw.discountCodes ?? [],
    customerId: customer?.id ?? null,
    customer: customer?.id
      ? {
          id: customer.id,
          firstName: customer.firstName ?? undefined,
          lastName: customer.lastName ?? undefined,
          email: customer.email ?? undefined,
          phone: customer.phone ?? undefined,
        }
      : undefined,
    shippingAddress: raw.shippingAddress ?? null,
    lineItems: (raw.lineItems?.edges ?? []).map((edge) => ({
      title: edge.node.title,
      quantity: edge.node.quantity,
      sku: edge.node.sku ?? undefined,
    })),
    fulfillments,
  };
}

export function summarizeOrder(order: ShopifyOrder): OrderSummary {
  const courier =
    order.fulfillments.find((f) => f.trackingCompany)?.trackingCompany ?? null;
  return {
    id: order.id,
    name: order.name,
    status: order.displayFulfillmentStatus,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    courierName: courier,
    createdAt: order.createdAt,
  };
}

export function normalizeOrderNumberForSearch(input: string): string {
  return input.trim().replace(/^#/, '');
}

const GID_PREFIX = 'gid://shopify/Order/';

export function buildOrderQueryClause(input: string): {
  query: string;
  kind: 'numeric_id' | 'name';
  needle: string;
} {
  const trimmed = input.trim();
  if (trimmed.startsWith(GID_PREFIX)) {
    const numeric = trimmed.slice(GID_PREFIX.length).split('?')[0];
    if (/^\d+$/.test(numeric)) {
      return {
        query: `id:${numeric}`,
        kind: 'numeric_id',
        needle: `${GID_PREFIX}${numeric}`,
      };
    }
  }
  const stripped = trimmed.replace(/^#/, '');
  if (/^\d{10,}$/.test(stripped)) {
    return {
      query: `id:${stripped}`,
      kind: 'numeric_id',
      needle: `${GID_PREFIX}${stripped}`,
    };
  }
  return { query: `name:${stripped}`, kind: 'name', needle: stripped };
}

interface RawProductResponse {
  id: string;
  handle: string;
  title: string;
  description?: string | null;
  onlineStoreUrl?: string | null;
  tags?: string[] | null;
  totalInventory?: number | null;
  priceRangeV2?: {
    minVariantPrice?: { amount: string; currencyCode: string };
    maxVariantPrice?: { amount: string; currencyCode: string };
  } | null;
  featuredImage?: { url: string; altText?: string | null } | null;
  images?: {
    edges: Array<{ node: { url: string; altText?: string | null } }>;
  } | null;
}

export function mapProductResponse(raw: RawProductResponse): ShopifyProduct {
  const minAmount = raw.priceRangeV2?.minVariantPrice?.amount ?? '0';
  const maxAmount = raw.priceRangeV2?.maxVariantPrice?.amount ?? minAmount;
  const currency =
    raw.priceRangeV2?.minVariantPrice?.currencyCode ??
    raw.priceRangeV2?.maxVariantPrice?.currencyCode ??
    'INR';
  const imageEdges = raw.images?.edges ?? [];
  const allImages = raw.featuredImage
    ? [raw.featuredImage, ...imageEdges.map((e) => e.node)]
    : imageEdges.map((e) => e.node);
  return {
    id: raw.id,
    handle: raw.handle,
    title: raw.title,
    description: raw.description ?? undefined,
    onlineStoreUrl: raw.onlineStoreUrl ?? undefined,
    priceRange: {
      minVariantPrice: minAmount,
      maxVariantPrice: maxAmount,
      currencyCode: currency,
    },
    available: (raw.totalInventory ?? 0) > 0,
    tags: raw.tags ?? [],
    images: allImages.map((img) => ({
      url: img.url,
      altText: img.altText ?? undefined,
    })),
  };
}

type ToolContent = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function jsonContent(value: unknown): ToolContent {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

export function toolErrorContent(
  errOrCode: unknown,
  message?: string,
): ToolContent {
  if (errOrCode instanceof ShopifyAdapterError) {
    const isCustomerSafe =
      errOrCode.details &&
      typeof errOrCode.details === 'object' &&
      (errOrCode.details as { customerSafe?: unknown }).customerSafe === true;
    if (isCustomerSafe) {
      return {
        content: [{ type: 'text', text: errOrCode.message }],
        isError: true,
      };
    }
    const payload: Record<string, unknown> = {
      code: errOrCode.code,
      message: errOrCode.message,
    };
    if (errOrCode.details && typeof errOrCode.details === 'object') {
      const reason = (errOrCode.details as { reason?: unknown }).reason;
      if (typeof reason === 'string') payload.reason = reason;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: payload }) }],
      isError: true,
    };
  }
  if (typeof errOrCode === 'string') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: { code: errOrCode, message: message ?? errOrCode },
          }),
        },
      ],
      isError: true,
    };
  }
  // Unhandled non-Shopify throws: report as INTERNAL_ERROR so callers can
  // distinguish coding bugs from user-input errors. The full stack is logged
  // by the HTTP server's request-level error handler.
  const text =
    errOrCode instanceof Error ? errOrCode.message : String(errOrCode);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: { code: 'INTERNAL_ERROR', message: text },
        }),
      },
    ],
    isError: true,
  };
}
