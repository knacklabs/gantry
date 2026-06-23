import { ShopifyAdapterError } from '../errors.js';
import type { Logger } from '../logger.js';

export interface TokenManagerOptions {
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  refreshLeadTimeMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  scope?: string;
}

const DEFAULT_REFRESH_LEAD_MS = 300_000;
const DEFAULT_EXPIRES_IN_SECONDS = 86_399;

export class TokenManager {
  private readonly shopDomain: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshLeadTimeMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger?: Logger;

  private cached: CachedToken | null = null;
  private inFlight: Promise<CachedToken> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: TokenManagerOptions) {
    this.shopDomain = opts.shopDomain;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.refreshLeadTimeMs = opts.refreshLeadTimeMs ?? DEFAULT_REFRESH_LEAD_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.logger = opts.logger;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs) {
      return this.cached.accessToken;
    }
    const token = await this.refresh();
    return token.accessToken;
  }

  async forceRefresh(): Promise<string> {
    this.cached = null;
    const token = await this.refresh();
    return token.accessToken;
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private refresh(): Promise<CachedToken> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchToken(): Promise<CachedToken> {
    const url =
      `https://${this.shopDomain}/admin/oauth/access_token` +
      `?grant_type=client_credentials` +
      `&client_id=${encodeURIComponent(this.clientId)}` +
      `&client_secret=${encodeURIComponent(this.clientSecret)}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (err) {
      throw new ShopifyAdapterError(
        'NETWORK_ERROR',
        `Token acquisition network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyAdapterError(
        'INVALID_CREDENTIALS',
        `Shopify rejected client_credentials grant — auth may require a different mechanism (verify cURL works server-side, may need Authorization Code grant or App Token instead). status=${response.status}`,
        { status: response.status },
      );
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new ShopifyAdapterError(
        'RATE_LIMITED',
        `Shopify token endpoint rate-limited (429); Retry-After=${retryAfter ?? 'unknown'}`,
        {
          retryAfterMs: retryAfter ? Number.parseFloat(retryAfter) * 1000 : null,
        },
      );
    }

    if (response.status >= 500) {
      throw new ShopifyAdapterError(
        'UNAVAILABLE',
        `Shopify token endpoint unavailable (${response.status})`,
        { status: response.status },
      );
    }

    if (!response.ok) {
      throw new ShopifyAdapterError(
        'INVALID_REQUEST',
        `Token endpoint returned ${response.status}`,
        { status: response.status },
      );
    }

    let payload: TokenResponse;
    try {
      payload = (await response.json()) as TokenResponse;
    } catch (err) {
      throw new ShopifyAdapterError(
        'INVALID_REQUEST',
        `Token endpoint returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!payload?.access_token) {
      throw new ShopifyAdapterError(
        'INVALID_REQUEST',
        'Token endpoint returned no access_token',
      );
    }

    const expiresInSec = payload.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS;
    const expiresAtMs =
      this.now() + expiresInSec * 1000 - this.refreshLeadTimeMs;

    const cached: CachedToken = {
      accessToken: payload.access_token,
      expiresAtMs,
    };
    this.cached = cached;
    this.scheduleProactiveRefresh(expiresAtMs);
    return cached;
  }

  private scheduleProactiveRefresh(expiresAtMs: number): void {
    if (this.stopped) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(1000, expiresAtMs - this.now());
    this.refreshTimer = setTimeout(() => {
      // Proactive refresh runs while the cached token is still valid (we
      // scheduled it `refreshLeadTimeMs` before expiry). If it fails, the
      // cache stays valid until expiresAtMs, at which point getToken() will
      // retry synchronously and surface any further errors to the caller.
      this.refresh().catch((err) => {
        this.logger?.warn(
          {
            err: err instanceof Error ? err.message : String(err),
          },
          'shopify_mcp_token_proactive_refresh_failed',
        );
      });
    }, delay);
    if (typeof this.refreshTimer === 'object' && this.refreshTimer) {
      const handle = this.refreshTimer as unknown as { unref?: () => void };
      handle.unref?.();
    }
  }
}
