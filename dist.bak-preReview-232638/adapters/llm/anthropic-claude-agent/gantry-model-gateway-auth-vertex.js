import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 55 * 60_000;
const DEFAULT_TOKEN_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOKEN_CACHE_ENTRIES = 128;
const VERTEX_ADC_CACHE_KEY = 'vertex-adc';
const tokenCache = new Map();
export async function getVertexServiceAccountBearerToken(input) {
    const nowMs = input.nowMs ?? Date.now();
    const tokenRequestTimeoutMs = input.tokenRequestTimeoutMs ?? DEFAULT_TOKEN_REQUEST_TIMEOUT_MS;
    const credentials = parseServiceAccountCredentials(input.serviceAccountJson);
    const cacheKey = credentialCacheKey(`${input.expectedProjectId}\0${input.serviceAccountJson}`);
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs + TOKEN_EXPIRY_SKEW_MS) {
        tokenCache.delete(cacheKey);
        tokenCache.set(cacheKey, cached);
        return cached.token;
    }
    const auth = new GoogleAuth({
        credentials,
        scopes: [CLOUD_PLATFORM_SCOPE],
    });
    const client = (await withTimeout(auth.getClient(), tokenRequestTimeoutMs));
    const accessToken = await withTimeout(client.getAccessToken(), tokenRequestTimeoutMs);
    const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
    if (!token) {
        throw new Error('Invalid Vertex service account credential.');
    }
    const expiryDate = client.credentials?.expiry_date;
    const expiresAtMs = typeof expiryDate === 'number' && Number.isFinite(expiryDate)
        ? expiryDate
        : nowMs + DEFAULT_TOKEN_TTL_MS;
    cacheToken(cacheKey, {
        token,
        expiresAtMs: Math.max(nowMs, expiresAtMs - TOKEN_EXPIRY_SKEW_MS),
    });
    return token;
}
export async function getVertexAdcBearerToken(input = {}) {
    const nowMs = input.nowMs ?? Date.now();
    const tokenRequestTimeoutMs = input.tokenRequestTimeoutMs ?? DEFAULT_TOKEN_REQUEST_TIMEOUT_MS;
    const cached = tokenCache.get(VERTEX_ADC_CACHE_KEY);
    if (cached && cached.expiresAtMs > nowMs + TOKEN_EXPIRY_SKEW_MS) {
        tokenCache.delete(VERTEX_ADC_CACHE_KEY);
        tokenCache.set(VERTEX_ADC_CACHE_KEY, cached);
        return cached.token;
    }
    const auth = new GoogleAuth({
        scopes: [CLOUD_PLATFORM_SCOPE],
    });
    const client = (await withTimeout(auth.getClient(), tokenRequestTimeoutMs));
    const accessToken = await withTimeout(client.getAccessToken(), tokenRequestTimeoutMs);
    const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
    if (!token) {
        throw new Error('Google ADC did not return a Vertex access token.');
    }
    const expiryDate = client.credentials?.expiry_date;
    const expiresAtMs = typeof expiryDate === 'number' && Number.isFinite(expiryDate)
        ? expiryDate
        : nowMs + DEFAULT_TOKEN_TTL_MS;
    cacheToken(VERTEX_ADC_CACHE_KEY, {
        token,
        expiresAtMs: Math.max(nowMs, expiresAtMs - TOKEN_EXPIRY_SKEW_MS),
    });
    return token;
}
export function clearVertexTokenCacheForTest() {
    tokenCache.clear();
}
function parseServiceAccountCredentials(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch (error) {
        throw new Error('Invalid Vertex service account credential.', {
            cause: error,
        });
    }
    if (!parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        parsed.type !== 'service_account' ||
        typeof parsed.project_id !== 'string' ||
        typeof parsed.client_email !== 'string' ||
        typeof parsed.private_key !== 'string') {
        throw new Error('Invalid Vertex service account credential.');
    }
    const source = parsed;
    if (source.token_uri !== undefined &&
        source.token_uri !== GOOGLE_OAUTH_TOKEN_ENDPOINT) {
        throw new Error('Invalid Vertex service account credential.');
    }
    const credentials = {
        type: 'service_account',
        project_id: source.project_id,
        client_email: source.client_email,
        private_key: source.private_key,
        token_uri: GOOGLE_OAUTH_TOKEN_ENDPOINT,
    };
    for (const field of ['private_key_id', 'client_id']) {
        if (typeof source[field] === 'string') {
            credentials[field] = source[field];
        }
    }
    return credentials;
}
function credentialCacheKey(value) {
    return createHash('sha256').update(value).digest('hex');
}
function cacheToken(cacheKey, token) {
    if (!tokenCache.has(cacheKey) && tokenCache.size >= MAX_TOKEN_CACHE_ENTRIES) {
        const oldestKey = tokenCache.keys().next().value;
        if (oldestKey)
            tokenCache.delete(oldestKey);
    }
    tokenCache.set(cacheKey, token);
}
function withTimeout(promise, timeoutMs) {
    let timeout;
    const timeoutPromise = new Promise((_resolve, reject) => {
        timeout = setTimeout(() => {
            reject(new Error('Vertex service account token request timed out.'));
        }, timeoutMs);
        if (typeof timeout === 'object') {
            timeout.unref?.();
        }
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        if (timeout)
            clearTimeout(timeout);
    });
}
