import { DEFAULT_BROWSER_KEEPALIVE_MS } from './browser-config.js';
export function resolveBrowserKeepAliveMs(value) {
    return Math.max(10_000, value || DEFAULT_BROWSER_KEEPALIVE_MS);
}
