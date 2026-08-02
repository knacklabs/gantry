import { createHash, timingSafeEqual } from 'node:crypto';
export { CONTROL_API_SCOPES, parseControlApiKeys, parseControlApiKeysStrict, } from '../../shared/control-api-keys.js';
export { isValidControlId } from '../../shared/control-id.js';
export function authenticate(req, requiredScopes, keys) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        return { status: 'missing' };
    const token = header.slice('Bearer '.length).trim();
    if (!token)
        return { status: 'missing' };
    const provided = createHash('sha256').update(token).digest();
    for (const key of keys) {
        if (key.tokenHash.length === provided.length &&
            timingSafeEqual(key.tokenHash, provided)) {
            const missingScopes = requiredScopes.filter((scope) => !key.scopes.has(scope));
            if (missingScopes.length === 0) {
                return { status: 'authenticated', key };
            }
            return { status: 'forbidden', key, missingScopes };
        }
    }
    return { status: 'invalid' };
}
