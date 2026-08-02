import type { BrowserBackendAction } from '../shared/browser-backend-actions.js';
import { normalizeBrowserSiteFromUrl } from '../shared/browser-site.js';
export type BrowserUsagePolicyMode = 'audit' | 'enforce';
export interface BrowserUsageOverride {
    mode?: BrowserUsagePolicyMode;
    windowMs?: number;
    maxActionsPerWindow?: number;
    maxConcurrentPerSite?: number;
}
export interface BrowserUsageSettings {
    enabled: boolean;
    mode: BrowserUsagePolicyMode;
    windowMs: number;
    maxActionsPerWindow: number;
    maxConcurrentPerSite: number;
    overrides: Record<string, BrowserUsageOverride>;
}
export interface BrowserUsagePolicyDecision {
    action: BrowserBackendAction;
    normalizedSite: string;
    profileName: string;
    policyMode: 'disabled' | BrowserUsagePolicyMode;
    allowed: boolean;
    warning?: string;
}
export declare function beginBrowserUsage(input: {
    action: BrowserBackendAction;
    payload: Record<string, unknown>;
    profileName: string;
    settings?: BrowserUsageSettings;
    payloadUrl?: string | null;
    activeUrl?: string;
}): BrowserUsagePolicyDecision;
export declare function finishBrowserUsage(decision: BrowserUsagePolicyDecision): void;
export declare function rememberBrowserUsageSite(input: {
    action: BrowserBackendAction;
    payload: Record<string, unknown>;
    profileName: string;
    ok: boolean;
    payloadUrl?: string | null;
    activeUrl?: string;
}): void;
export declare function resetBrowserUsageGovernorForTests(): void;
export declare function browserUsageBucketCountForTests(): number;
export { normalizeBrowserSiteFromUrl };
