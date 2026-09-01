import { chromium, type Browser, type Route } from 'playwright-core';

import { resolvePublicEgressAddress } from '../shared/egress-target-resolution.js';
import { nowMs } from '../shared/time/datetime.js';

const PUBLIC_ADDRESS_CACHE_MS = 60_000;
const policies = new Map<
  number,
  {
    browser: Browser;
    allowedHosts: readonly string[];
    allowPublicNavigationDiscovery: boolean;
  }
>();
const pending = new Map<number, Promise<void>>();
const publicHostCache = new Map<string, number>();
const navigationDenials = new Map<
  number,
  { url: string; reason: BrowserNetworkPolicyDenialReason }
>();

export type BrowserNetworkPolicyDenialReason =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'navigation_host_not_allowed'
  | 'non_public_address';

export function lastBrowserNetworkPolicyNavigationDenial(
  port: number,
): { url: string; reason: BrowserNetworkPolicyDenialReason } | undefined {
  return navigationDenials.get(port);
}

export function clearBrowserNetworkPolicyNavigationDenial(port: number): void {
  navigationDenials.delete(port);
}

export function browserNavigationHostAllowed(
  hostname: string,
  allowedHosts: readonly string[],
  allowPublicNavigationDiscovery = false,
): boolean {
  if (allowPublicNavigationDiscovery) return true;
  if (allowedHosts.length === 0) return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return allowedHosts.some((entry) => {
    const allowed = entry
      .toLowerCase()
      .trim()
      .replace(/^https?:\/\//, '');
    if (!allowed) return false;
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === allowed.split('/')[0]?.split(':')[0];
  });
}

export async function ensureBrowserNetworkPolicy(input: {
  port: number;
  allowedHosts: readonly string[];
  allowPublicNavigationDiscovery?: boolean;
}): Promise<void> {
  const existing = policies.get(input.port);
  if (existing) {
    existing.allowedHosts = [...input.allowedHosts];
    existing.allowPublicNavigationDiscovery =
      input.allowPublicNavigationDiscovery === true;
    return;
  }
  const inFlight = pending.get(input.port);
  if (inFlight) {
    await inFlight;
    const installed = policies.get(input.port);
    if (installed) {
      installed.allowedHosts = [...input.allowedHosts];
      installed.allowPublicNavigationDiscovery =
        input.allowPublicNavigationDiscovery === true;
    }
    return;
  }
  const installation = install(input);
  pending.set(input.port, installation);
  try {
    await installation;
  } finally {
    pending.delete(input.port);
  }
}

async function install(input: {
  port: number;
  allowedHosts: readonly string[];
  allowPublicNavigationDiscovery?: boolean;
}) {
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${input.port}`,
  );
  const state = {
    browser,
    allowedHosts: [...input.allowedHosts],
    allowPublicNavigationDiscovery:
      input.allowPublicNavigationDiscovery === true,
  };
  policies.set(input.port, state);
  browser.on('disconnected', () => {
    policies.delete(input.port);
    navigationDenials.delete(input.port);
  });
  for (const context of browser.contexts()) {
    await context.route('**/*', async (route) =>
      guardRoute(route, state, input.port),
    );
  }
}

async function guardRoute(
  route: Route,
  state: {
    allowedHosts: readonly string[];
    allowPublicNavigationDiscovery: boolean;
  },
  port: number,
) {
  if (state.allowedHosts.length === 0) {
    await route.continue();
    return;
  }
  const request = route.request();
  let url: URL;
  try {
    url = new URL(request.url());
  } catch {
    rememberNavigationDenial(
      port,
      request.isNavigationRequest(),
      request.url(),
      'invalid_url',
    );
    await route.abort('blockedbyclient');
    return;
  }
  if (['data:', 'blob:', 'about:'].includes(url.protocol)) {
    await route.continue();
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    rememberNavigationDenial(
      port,
      request.isNavigationRequest(),
      url.href,
      'unsupported_protocol',
    );
    await route.abort('blockedbyclient');
    return;
  }
  if (
    request.isNavigationRequest() &&
    !browserNavigationHostAllowed(
      url.hostname,
      state.allowedHosts,
      state.allowPublicNavigationDiscovery,
    )
  ) {
    rememberNavigationDenial(
      port,
      true,
      url.href,
      'navigation_host_not_allowed',
    );
    await route.abort('blockedbyclient');
    return;
  }
  if (!(await isPublicHost(url.hostname))) {
    rememberNavigationDenial(
      port,
      request.isNavigationRequest(),
      url.href,
      'non_public_address',
    );
    await route.abort('blockedbyclient');
    return;
  }
  await route.continue();
}

function rememberNavigationDenial(
  port: number,
  navigationRequest: boolean,
  url: string,
  reason: BrowserNetworkPolicyDenialReason,
): void {
  if (navigationRequest) navigationDenials.set(port, { url, reason });
}

async function isPublicHost(hostname: string) {
  const cachedUntil = publicHostCache.get(hostname);
  if (cachedUntil && cachedUntil > nowMs()) return true;
  const resolved = await resolvePublicEgressAddress(hostname);
  if (!resolved.ok) return false;
  publicHostCache.set(hostname, nowMs() + PUBLIC_ADDRESS_CACHE_MS);
  return true;
}
