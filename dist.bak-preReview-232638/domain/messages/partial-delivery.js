import { sanitizeRetryTailProviderPayload } from './retry-tail-provider-payload.js';
const PARTIAL_MESSAGE_DELIVERY_BRAND = Symbol('gantry.partialMessageDelivery');
export class PartialMessageDeliveryError extends Error {
    [PARTIAL_MESSAGE_DELIVERY_BRAND] = true;
    partialMessageDelivery = true;
    deliveredChunks;
    totalChunks;
    cause;
    constructor(args) {
        super(args.message);
        this.name = args.name;
        this.cause = args.cause;
        this.deliveredChunks = args.deliveredChunks;
        this.totalChunks = args.totalChunks;
    }
}
export function isPartialMessageDeliveryError(err) {
    return (typeof err === 'object' &&
        err !== null &&
        err[PARTIAL_MESSAGE_DELIVERY_BRAND] === true &&
        err.partialMessageDelivery ===
            true &&
        err.deliveredChunks !== undefined &&
        Number.isSafeInteger(err.deliveredChunks) &&
        err.deliveredChunks > 0);
}
export function getPartialMessageDeliveryMetadata(err) {
    if (!isPartialMessageDeliveryError(err))
        return {};
    const candidate = err;
    const deliveredParts = Number.isSafeInteger(candidate.deliveredParts) &&
        candidate.deliveredParts > 0
        ? candidate.deliveredParts
        : err.deliveredChunks;
    const totalParts = Number.isSafeInteger(candidate.totalParts) &&
        candidate.totalParts > 0
        ? candidate.totalParts
        : err.totalChunks;
    const provider = typeof candidate.provider === 'string' && candidate.provider.trim()
        ? candidate.provider.trim()
        : undefined;
    const externalMessageIds = Array.isArray(candidate.externalMessageIds)
        ? candidate.externalMessageIds.filter((value) => typeof value === 'string' && value.length > 0)
        : undefined;
    const sentPrefix = typeof candidate.sentPrefix === 'string' ? candidate.sentPrefix : undefined;
    const retryTail = normalizeRetryTail(candidate.retryTail);
    return {
        deliveredParts,
        totalParts,
        ...(provider !== undefined ? { provider } : {}),
        ...(externalMessageIds && externalMessageIds.length > 0
            ? { externalMessageIds }
            : {}),
        ...(sentPrefix !== undefined ? { sentPrefix } : {}),
        ...(retryTail ? { retryTail } : {}),
    };
}
function normalizeRetryTail(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const candidate = value;
    if (typeof candidate.canonicalText !== 'string')
        return undefined;
    const canonicalText = candidate.canonicalText.replace(/\r\n/g, '\n');
    if (!canonicalText.trim())
        return undefined;
    const providerPayload = candidate.providerPayload === undefined
        ? undefined
        : sanitizeRetryTailProviderPayload(candidate.providerPayload);
    return {
        canonicalText,
        ...(providerPayload !== undefined ? { providerPayload } : {}),
    };
}
