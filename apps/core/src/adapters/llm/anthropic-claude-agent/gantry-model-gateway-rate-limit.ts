// In-memory per-(app, provider) sliding-window request rate limiter for the
// Gantry model gateway. No DB, no persistence, no usage-body parsing: it tracks
// only request timestamps within a fixed 60s window and is cleared on broker
// close. Structurally compatible with the runtime `limits` settings block, but
// declared here so the adapter does not import the config layer.

export interface GatewayProviderRateLimit {
  requestsPerMinute: number;
}

export interface GatewayProviderRateLimits {
  providers: Record<string, GatewayProviderRateLimit>;
}

const WINDOW_MS = 60_000;

export class GatewayRateLimiter {
  // Request timestamps keyed by `${appId}:${provider}`, pruned to the window on
  // each admission check.
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly getLimits?: () => GatewayProviderRateLimits) {}

  // Configured requests-per-minute cap for a provider, or undefined when none.
  // Reads the live getter each call so a settings reload applies immediately.
  requestsPerMinute(providerId: string): number | undefined {
    return this.getLimits?.().providers[providerId]?.requestsPerMinute;
  }

  // Sliding-window admission for one (app, provider). Prunes timestamps older
  // than the window, rejects (without recording) when the weighted request
  // would exceed the window, otherwise records its weight and admits.
  admit(
    appId: string,
    providerId: string,
    limit: number,
    weight = 1,
    nowMs = Date.now(),
  ): boolean {
    const key = `${appId}:${providerId}`;
    const cutoff = nowMs - WINDOW_MS;
    const recent = (this.windows.get(key) ?? []).filter(
      (timestamp) => timestamp > cutoff,
    );
    const normalizedWeight = Math.max(1, Math.floor(weight));
    if (recent.length + normalizedWeight > limit) {
      this.windows.set(key, recent);
      return false;
    }
    recent.push(...Array.from({ length: normalizedWeight }, () => nowMs));
    this.windows.set(key, recent);
    return true;
  }

  clear(): void {
    this.windows.clear();
  }
}

// Enforce the per-provider cap for one request. When a cap is configured and the
// window is full, audits the rejection, sends a 429 with a clear body via the
// injected responder, and returns true (caller must stop before upstream fetch).
// Returns false when no cap applies or the request is admitted.
export async function applyRateCap(input: {
  limiter: GatewayRateLimiter;
  appId: string;
  providerId: string;
  weight?: number;
  audit: (limit: number) => Promise<unknown> | unknown;
  reject: (limit: number) => void;
}): Promise<boolean> {
  const limit = input.limiter.requestsPerMinute(input.providerId);
  if (limit === undefined) return false;
  if (
    input.limiter.admit(input.appId, input.providerId, limit, input.weight ?? 1)
  )
    return false;
  await input.audit(limit);
  input.reject(limit);
  return true;
}
