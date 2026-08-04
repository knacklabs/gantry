import { GoogleAuth } from 'google-auth-library';
import { AwsSecretsManagerRuntimeSecretProvider } from '../../credentials/aws-secrets-manager-runtime-secret-provider.js';
import { EnvRuntimeSecretProvider } from '../../credentials/env-runtime-secret-provider.js';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_SECRET_REQUEST_TIMEOUT_MS = 30_000;
const AWS_SECRET_REF_PATTERN = /^aws-sm:(.+)$/;
const GCP_SECRET_REF_PATTERN = /^gcp-sm:(projects\/[^/\r\n]+\/(?:locations\/[^/\r\n]+\/)?secrets\/[^/\r\n]+\/versions\/[^/\r\n]+)$/;
export async function resolveModelCredentialSecretRef(ref) {
    const awsMatch = AWS_SECRET_REF_PATTERN.exec(ref);
    if (awsMatch) {
        const normalized = `aws-sm:${awsMatch[1].trim()}`;
        const value = await new AwsSecretsManagerRuntimeSecretProvider(new EnvRuntimeSecretProvider()).getOptionalSecretAsync({ ref: normalized });
        if (value)
            return value;
        throw new Error(`Model credential secret ref ${normalized} did not resolve.`);
    }
    const gcpMatch = GCP_SECRET_REF_PATTERN.exec(ref);
    if (gcpMatch) {
        return fetchGoogleSecretManagerValue(gcpMatch[1]);
    }
    throw new Error('Model credential secret refs must use aws-sm:<name-or-arn> or gcp-sm:projects/<project>/secrets/<secret>/versions/<version>.');
}
async function fetchGoogleSecretManagerValue(name) {
    const auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });
    const client = (await withTimeout(auth.getClient(), DEFAULT_SECRET_REQUEST_TIMEOUT_MS));
    const accessToken = await withTimeout(client.getAccessToken(), DEFAULT_SECRET_REQUEST_TIMEOUT_MS);
    const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
    if (!token) {
        throw new Error('Google Secret Manager credential did not return a token.');
    }
    const response = await withTimeout(fetch(`https://secretmanager.googleapis.com/v1/${encodeGcpResourceName(name)}:access`, { headers: { authorization: `Bearer ${token}` } }), DEFAULT_SECRET_REQUEST_TIMEOUT_MS);
    if (!response.ok) {
        throw new Error(`Google Secret Manager ref ${name} did not resolve.`);
    }
    const body = (await response.json());
    const data = body.payload?.data;
    if (typeof data !== 'string' || !data) {
        throw new Error(`Google Secret Manager ref ${name} returned no payload.`);
    }
    return Buffer.from(data, 'base64').toString('utf8');
}
function encodeGcpResourceName(name) {
    return name.split('/').map(encodeURIComponent).join('/');
}
function withTimeout(promise, timeoutMs) {
    let timeout;
    const timer = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Model credential secret request timed out.')), timeoutMs);
    });
    return Promise.race([promise, timer]).finally(() => {
        if (timeout)
            clearTimeout(timeout);
    });
}
