import dns from 'node:dns/promises';
import { evaluateNonPublicEgressAddress, normalizeEgressHost, } from './egress-policy.js';
import { lookupHostnameWithDeadline } from './hostname-lookup-deadline.js';
import { isIpAddress } from './network-host-declaration.js';
const EGRESS_DNS_LOOKUP_TIMEOUT_MS = 30_000;
export function normalizeEgressAuthorityHost(authority) {
    const value = authority.trim();
    if (!value)
        return undefined;
    if (isIpAddress(value))
        return normalizeEgressHost(value);
    if (value.includes('://') ||
        value.includes('/') ||
        value.includes('@') ||
        value.includes('?') ||
        value.includes('#')) {
        return undefined;
    }
    try {
        const parsed = new URL(`http://${value}`);
        const host = normalizeEgressHost(parsed.hostname);
        return host || undefined;
    }
    catch {
        return undefined;
    }
}
export async function resolvePublicEgressAddress(rawHost) {
    const host = normalizeEgressHost(rawHost);
    if (!host)
        return { ok: false, host };
    if (host === 'localhost' || host.endsWith('.localhost')) {
        return {
            ok: false,
            host,
            deny: {
                host,
                matchedPattern: 'non-public-address',
                reason: `Host ${host} is a loopback hostname.`,
            },
        };
    }
    if (isIpAddress(host)) {
        const address = host.replace(/^\[/, '').replace(/\]$/, '');
        const deny = evaluateNonPublicEgressAddress({ host, address });
        return deny
            ? { ok: false, host, deny }
            : {
                ok: true,
                host,
                address,
                family: address.includes(':') ? 6 : 4,
            };
    }
    let records;
    try {
        records = await lookupHostnameWithDeadline({
            hostname: host,
            lookupHostname: lookupEgressHostname,
            timeoutMs: EGRESS_DNS_LOOKUP_TIMEOUT_MS,
            timeoutMessage: 'Egress DNS lookup timed out.',
        });
    }
    catch {
        return { ok: false, host };
    }
    const first = records[0];
    if (!first)
        return { ok: false, host };
    for (const record of records) {
        const deny = evaluateNonPublicEgressAddress({
            host,
            address: record.address,
        });
        if (deny)
            return { ok: false, host, deny };
    }
    return { ok: true, host, address: first.address, family: first.family };
}
async function lookupEgressHostname(hostname) {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records
        .filter((record) => record.family === 4 || record.family === 6)
        .map((record) => ({
        address: record.address,
        family: record.family,
    }));
}
