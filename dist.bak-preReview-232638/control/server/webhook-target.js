import net from 'node:net';
import { hostnameForNetwork, isPrivateNetworkAddress, } from '../../domain/network/public-address-policy.js';
import { defaultHostnameLookup } from '../../infrastructure/network/hostname-lookup.js';
export const isPrivateAddress = isPrivateNetworkAddress;
export { hostnameForNetwork };
export async function validateWebhookTarget(targetUrl) {
    const parsed = new URL(targetUrl);
    const allowInsecure = process.env.GANTRY_CONTROL_ALLOW_INSECURE_WEBHOOKS === 'true';
    const allowPrivate = process.env.GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS === 'true';
    const allowlist = new Set((process.env.GANTRY_CONTROL_WEBHOOK_ALLOWED_HOSTS || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean));
    if (!allowInsecure && parsed.protocol !== 'https:') {
        throw Object.assign(new Error('Webhook URL must use https'), {
            code: 'INVALID_WEBHOOK_URL',
            statusCode: 400,
        });
    }
    if (parsed.username || parsed.password) {
        throw Object.assign(new Error('Webhook URL must not include credentials'), {
            code: 'INVALID_WEBHOOK_URL',
            statusCode: 400,
        });
    }
    const hostname = hostnameForNetwork(parsed.hostname).toLowerCase();
    if (allowlist.size > 0 && !allowlist.has(hostname)) {
        throw Object.assign(new Error('Webhook host is not allowlisted'), {
            code: 'WEBHOOK_HOST_DENIED',
            statusCode: 403,
        });
    }
    if (!allowPrivate) {
        if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
            throw Object.assign(new Error('Webhook host must be publicly routable'), {
                code: 'WEBHOOK_HOST_DENIED',
                statusCode: 403,
            });
        }
        if (net.isIP(hostname) && isPrivateNetworkAddress(hostname)) {
            throw Object.assign(new Error('Webhook host must be publicly routable'), {
                code: 'WEBHOOK_HOST_DENIED',
                statusCode: 403,
            });
        }
        const records = await defaultHostnameLookup(hostname);
        if (records.some((record) => isPrivateNetworkAddress(record.address))) {
            throw Object.assign(new Error('Webhook host must be publicly routable'), {
                code: 'WEBHOOK_HOST_DENIED',
                statusCode: 403,
            });
        }
        const publicRecord = records.find((record) => !isPrivateNetworkAddress(record.address));
        if (publicRecord) {
            return {
                url: parsed,
                address: publicRecord.address,
                family: publicRecord.family,
            };
        }
    }
    if (net.isIP(hostname)) {
        return {
            url: parsed,
            address: hostname,
            family: net.isIP(hostname),
        };
    }
    const records = await defaultHostnameLookup(hostname);
    const record = records[0];
    if (!record) {
        throw Object.assign(new Error('Webhook host did not resolve'), {
            code: 'WEBHOOK_HOST_DENIED',
            statusCode: 403,
        });
    }
    return {
        url: parsed,
        address: record.address,
        family: record.family,
    };
}
