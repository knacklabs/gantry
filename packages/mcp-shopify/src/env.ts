export type IdentityConfig =
  | { mode: 'disabled' }
  | { mode: 'optional'; secret: string; maxAgeSec: number }
  | { mode: 'required'; secret: string; maxAgeSec: number };

export type ShopifyEnvMode = 'dev' | 'prod';

export interface ShopifyMcpEnv {
  mode: ShopifyEnvMode;
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  port: number;
  graphqlTimeoutMs: number;
  refreshLeadTimeMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  logFormat: 'json' | 'text';
  identity: IdentityConfig;
  /**
   * Convenience getters that flatten {@link identity} for the few callers that
   * just need the raw secret / boolean. Prefer reading `identity` directly when
   * branching on configuration mode.
   */
  identitySecret?: string;
  requireVerifiedIdentity: boolean;
  identityMaxAgeSec: number;
  /**
   * TTL (ms) for the verified-identity → customer-id cache used by
   * list_orders_for_customer and get_order_history. Set to 0 to disable.
   */
  identityCacheTtlMs: number;
  /**
   * TTL (ms) for compact product search results. Set to 0 to disable.
   */
  productSearchCacheTtlMs: number;
  /**
   * Start a background product-search refresh this long before cache expiry.
   */
  productSearchCacheRefreshLeadMs: number;
}

const VALID_LOG_LEVELS = new Set([
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const);

type LogLevel = ShopifyMcpEnv['logLevel'];

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return value;
}

function parsePositiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function parseNonNegativeInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'info';
  const lower = raw.toLowerCase();
  if (!VALID_LOG_LEVELS.has(lower as LogLevel)) {
    throw new Error(
      `Invalid LOG_LEVEL: ${raw} (allowed: ${[...VALID_LOG_LEVELS].join(', ')})`,
    );
  }
  return lower as LogLevel;
}

function parseIdentity(source: NodeJS.ProcessEnv): IdentityConfig {
  const secret = source.MCP_IDENTITY_SECRET?.trim() ?? '';
  const require =
    (source.SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY ?? '').toLowerCase() === 'true';
  const maxAgeSec = parsePositiveInt(
    'MCP_IDENTITY_MAX_AGE_SEC',
    source.MCP_IDENTITY_MAX_AGE_SEC,
    120,
  );

  if (require) {
    if (!secret) {
      throw new Error(
        'SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY=true requires MCP_IDENTITY_SECRET to be set',
      );
    }
    return { mode: 'required', secret, maxAgeSec };
  }
  if (secret) {
    return { mode: 'optional', secret, maxAgeSec };
  }
  return { mode: 'disabled' };
}

function parseShopifyMode(raw: string | undefined): ShopifyEnvMode {
  if (!raw || raw.trim() === '') return 'dev';
  const lower = raw.toLowerCase();
  if (lower !== 'dev' && lower !== 'prod') {
    throw new Error(
      `Invalid SHOPIFY_ENV: ${raw} (allowed: dev, prod)`,
    );
  }
  return lower;
}

interface ShopifyCredentials {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
}

function readShopifyCredentials(
  source: NodeJS.ProcessEnv,
  mode: ShopifyEnvMode,
): ShopifyCredentials {
  const prefix = mode === 'prod' ? 'SHOPIFY_PROD_' : 'SHOPIFY_DEV_';
  return {
    shopDomain: required(
      `${prefix}SHOP_DOMAIN`,
      source[`${prefix}SHOP_DOMAIN`],
    ),
    clientId: required(`${prefix}CLIENT_ID`, source[`${prefix}CLIENT_ID`]),
    clientSecret: required(
      `${prefix}CLIENT_SECRET`,
      source[`${prefix}CLIENT_SECRET`],
    ),
    apiVersion: source[`${prefix}API_VERSION`] ?? '2026-04',
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ShopifyMcpEnv {
  const mode = parseShopifyMode(source.SHOPIFY_ENV);
  const credentials = readShopifyCredentials(source, mode);
  const identity = parseIdentity(source);
  return {
    mode,
    ...credentials,
    port: parsePort(source.SHOPIFY_MCP_PORT, 8081),
    graphqlTimeoutMs: parsePositiveInt(
      'SHOPIFY_GRAPHQL_TIMEOUT_MS',
      source.SHOPIFY_GRAPHQL_TIMEOUT_MS,
      8_000,
    ),
    refreshLeadTimeMs: parsePositiveInt(
      'SHOPIFY_TOKEN_REFRESH_LEAD_MS',
      source.SHOPIFY_TOKEN_REFRESH_LEAD_MS,
      300_000,
    ),
    logLevel: parseLogLevel(source.LOG_LEVEL),
    logFormat: source.LOG_FORMAT === 'text' ? 'text' : 'json',
    identity,
    identitySecret: identity.mode === 'disabled' ? undefined : identity.secret,
    requireVerifiedIdentity: identity.mode === 'required',
    identityMaxAgeSec:
      identity.mode === 'disabled' ? 120 : identity.maxAgeSec,
    identityCacheTtlMs: parseNonNegativeInt(
      'SHOPIFY_MCP_IDENTITY_CACHE_TTL_MS',
      source.SHOPIFY_MCP_IDENTITY_CACHE_TTL_MS,
      30 * 60 * 1000, // 30 minutes
    ),
    productSearchCacheTtlMs: parseNonNegativeInt(
      'SHOPIFY_PRODUCT_SEARCH_CACHE_TTL_MS',
      source.SHOPIFY_PRODUCT_SEARCH_CACHE_TTL_MS,
      24 * 60 * 60 * 1000, // 24 hours
    ),
    productSearchCacheRefreshLeadMs: parseNonNegativeInt(
      'SHOPIFY_PRODUCT_SEARCH_CACHE_REFRESH_LEAD_MS',
      source.SHOPIFY_PRODUCT_SEARCH_CACHE_REFRESH_LEAD_MS,
      10 * 60 * 1000, // 10 minutes
    ),
  };
}
