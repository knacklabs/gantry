import { authenticate } from './auth.js';
import { sendError } from './http.js';
export function authorizeControlRequest(req, res, keys, scopes) {
    const auth = authenticate(req, scopes, keys);
    if (auth.status === 'authenticated') {
        return auth.key;
    }
    if (auth.status === 'forbidden') {
        sendError(res, 403, 'FORBIDDEN', `API key is missing required scope ${auth.missingScopes[0]}`);
        return null;
    }
    if (auth.status === 'missing') {
        sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid API key');
        return null;
    }
    sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid API key');
    return null;
}
