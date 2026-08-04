import dns from 'node:dns/promises';
import { isIpAddress, } from '../../domain/network/public-address-policy.js';
export const defaultHostnameLookup = async (hostname) => {
    if (isIpAddress(hostname)) {
        return [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }];
    }
    const records = await dns.lookup(hostname, { all: true });
    return records.map((record) => ({
        address: record.address,
        family: record.family,
    }));
};
