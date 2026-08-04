import type { BrowserProfileStatus, BrowserSessionStatus, LaunchBrowserOptions } from './browser-capability-types.js';
export declare const DEFAULT_BROWSER_PROFILE_NAME = "gantry";
export type { BrowserProfileStatus, BrowserSessionStatus, LaunchBrowserOptions, } from './browser-capability-types.js';
export declare function launchBrowser(opts?: LaunchBrowserOptions): Promise<BrowserSessionStatus>;
export declare function ensureBrowserReady(opts?: LaunchBrowserOptions): Promise<BrowserSessionStatus>;
export declare function getBrowserStatus(profileName?: string): Promise<BrowserSessionStatus>;
export declare function getKnownBrowserStatus(profileName?: string): BrowserSessionStatus;
export declare function closeBrowser(profileName?: string): Promise<{
    closed: boolean;
    reason?: string;
    elapsedMs?: number;
}>;
export declare function closeAllBrowsers(): Promise<void>;
export declare function listBrowserProfiles(): Promise<BrowserProfileStatus[]>;
