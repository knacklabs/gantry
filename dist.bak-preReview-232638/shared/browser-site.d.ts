export interface BrowserSiteKeyDetails {
    hostname: string;
    siteKey: string;
    isIp: boolean;
    isPublicSuffixOnly: boolean;
}
export declare function browserSiteKeyDetails(hostname: string): BrowserSiteKeyDetails | undefined;
export declare function normalizeBrowserSiteKey(hostname: string): string | undefined;
export declare function normalizeBrowserSiteFromUrl(value: unknown): string | undefined;
