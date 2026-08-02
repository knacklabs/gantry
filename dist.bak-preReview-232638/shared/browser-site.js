import { parse as parseDomain } from 'tldts';
export function browserSiteKeyDetails(hostname) {
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!normalized)
        return undefined;
    const parsed = parseDomain(normalized, {
        allowPrivateDomains: true,
    });
    const parsedHostname = parsed.hostname ?? normalized;
    const siteKey = parsed.domain ?? parsedHostname;
    return {
        hostname: parsedHostname,
        siteKey,
        isIp: parsed.isIp === true,
        isPublicSuffixOnly: parsed.publicSuffix === parsedHostname && parsed.domain === null,
    };
}
export function normalizeBrowserSiteKey(hostname) {
    return browserSiteKeyDetails(hostname)?.siteKey;
}
export function normalizeBrowserSiteFromUrl(value) {
    if (typeof value !== 'string' || !value.trim())
        return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return undefined;
        }
        return normalizeBrowserSiteKey(url.hostname);
    }
    catch {
        return undefined;
    }
}
