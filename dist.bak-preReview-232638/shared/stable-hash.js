import { createHash } from 'node:crypto';
export function sha256Hex(value) {
    return createHash('sha256').update(value).digest('hex');
}
export function sha256Base64Url(value) {
    return createHash('sha256').update(value).digest('base64url');
}
export function stableSha256Json(value) {
    return sha256Hex(canonicalJson(value));
}
function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]));
}
