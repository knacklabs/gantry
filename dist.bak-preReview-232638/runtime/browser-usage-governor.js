import { normalizeBrowserSiteFromUrl } from '../shared/browser-site.js';
import { nowMs } from '../shared/time/datetime.js';
const usageBuckets = new Map();
const currentSiteByProfile = new Map();
const UNMETERED_BROWSER_ACTIONS = new Set([
    'status',
    'open',
    'close',
]);
function browserUsageSite(input) {
    const rawPayloadUrl = input.payloadUrl === undefined ? input.payload.url : input.payloadUrl;
    const fromUrl = normalizeBrowserSiteFromUrl(rawPayloadUrl);
    if (fromUrl)
        return fromUrl;
    if (typeof rawPayloadUrl === 'string' && rawPayloadUrl.trim()) {
        return 'unknown';
    }
    const fromActiveUrl = normalizeBrowserSiteFromUrl(input.activeUrl);
    if (fromActiveUrl)
        return fromActiveUrl;
    if (typeof input.activeUrl === 'string' && input.activeUrl.trim()) {
        return 'unknown';
    }
    return currentSiteByProfile.get(input.profileName) ?? 'unknown';
}
function usageBucketKey(profileName, site) {
    return `${profileName}\0${site}`;
}
function resolveUsageRule(settings, site) {
    const override = settings.overrides[site];
    return {
        mode: override?.mode ?? settings.mode,
        windowMs: override?.windowMs ?? settings.windowMs,
        maxActionsPerWindow: override?.maxActionsPerWindow ?? settings.maxActionsPerWindow,
        maxConcurrentPerSite: override?.maxConcurrentPerSite ?? settings.maxConcurrentPerSite,
    };
}
function currentBucket(key, rule, now) {
    const existing = usageBuckets.get(key);
    if (existing && now < existing.expiresAtMs) {
        return existing;
    }
    const fresh = {
        windowStartedAtMs: now,
        expiresAtMs: now + rule.windowMs,
        actions: 0,
        active: 0,
    };
    usageBuckets.set(key, fresh);
    return fresh;
}
function pruneExpiredUsageBuckets(now) {
    for (const [key, bucket] of usageBuckets) {
        if (bucket.active <= 0 && now >= bucket.expiresAtMs) {
            usageBuckets.delete(key);
        }
    }
}
export function beginBrowserUsage(input) {
    const normalizedSite = browserUsageSite(input);
    if (!input.settings?.enabled) {
        return {
            action: input.action,
            normalizedSite,
            profileName: input.profileName,
            policyMode: 'disabled',
            allowed: true,
        };
    }
    if (UNMETERED_BROWSER_ACTIONS.has(input.action)) {
        return {
            action: input.action,
            normalizedSite,
            profileName: input.profileName,
            policyMode: input.settings.mode,
            allowed: true,
        };
    }
    const now = nowMs();
    pruneExpiredUsageBuckets(now);
    const rule = resolveUsageRule(input.settings, normalizedSite);
    const bucket = currentBucket(usageBucketKey(input.profileName, normalizedSite), rule, now);
    const warnings = [];
    if (bucket.active >= rule.maxConcurrentPerSite) {
        warnings.push(`site concurrency ${bucket.active + 1}/${rule.maxConcurrentPerSite}`);
    }
    if (bucket.actions + 1 > rule.maxActionsPerWindow) {
        warnings.push(`site action window ${bucket.actions + 1}/${rule.maxActionsPerWindow}`);
    }
    const allowed = rule.mode !== 'enforce' || warnings.length === 0;
    if (allowed) {
        bucket.active += 1;
        bucket.actions += 1;
    }
    return {
        action: input.action,
        normalizedSite,
        profileName: input.profileName,
        policyMode: rule.mode,
        allowed,
        ...(warnings.length > 0
            ? { warning: `Browser usage policy warning: ${warnings.join(', ')}` }
            : {}),
    };
}
export function finishBrowserUsage(decision) {
    if (decision.policyMode === 'disabled' || !decision.allowed)
        return;
    const bucket = usageBuckets.get(usageBucketKey(decision.profileName, decision.normalizedSite));
    if (!bucket)
        return;
    bucket.active = Math.max(0, bucket.active - 1);
}
export function rememberBrowserUsageSite(input) {
    if (!input.ok)
        return;
    const site = normalizeBrowserSiteFromUrl(input.payloadUrl === undefined ? input.payload.url : input.payloadUrl) ?? normalizeBrowserSiteFromUrl(input.activeUrl);
    if (site)
        currentSiteByProfile.set(input.profileName, site);
}
export function resetBrowserUsageGovernorForTests() {
    usageBuckets.clear();
    currentSiteByProfile.clear();
}
export function browserUsageBucketCountForTests() {
    return usageBuckets.size;
}
export { normalizeBrowserSiteFromUrl };
